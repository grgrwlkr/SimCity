//! Notification system for game events.

use bevy::prelude::*;
use bevy::time::Real;
use bevy_egui::{EguiContexts, egui};

use crate::game::sets::GameSet;
use crate::game::state::AppState;

/// Notification message
#[derive(Debug, Clone)]
pub struct Notification {
    pub text: String,
    pub kind: NotificationKind,
    pub created_at: f64,
    pub duration: f32, // seconds
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum NotificationKind {
    Info,
    Warning,
    Error,
    #[allow(dead_code)] // Reserved for future use
    Achievement,
}

/// Notification system resource
#[derive(Resource, Default)]
pub struct Notifications {
    messages: Vec<Notification>,
}

impl Notifications {
    pub fn add(&mut self, text: String, kind: NotificationKind, duration: f32) {
        self.messages.push(Notification {
            text,
            kind,
            created_at: 0.0, // Will be set by system
            duration,
        });
    }

    pub fn messages(&self) -> &[Notification] {
        &self.messages
    }

    pub fn remove_expired(&mut self, time_now: f64) {
        self.messages
            .retain(|n| (time_now - n.created_at) < n.duration as f64);
    }
}

pub struct NotificationsPlugin;

impl Plugin for NotificationsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Notifications>().add_systems(
            Update,
            notification_ui
                .in_set(GameSet::Ui)
                .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
        );
    }
}

/// Render notification UI
fn notification_ui(
    mut contexts: EguiContexts,
    time: Res<Time<Real>>,
    mut notifications: ResMut<Notifications>,
) {
    // Update timestamps for new notifications
    let time_now = time.elapsed_secs_f64();
    for msg in &mut notifications.messages {
        if msg.created_at == 0.0 {
            msg.created_at = time_now;
        }
    }

    // Remove expired
    notifications.remove_expired(time_now);
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };

    let messages = notifications.messages();
    if messages.is_empty() {
        return;
    }

    // Notifications sit just LEFT of the 200px right sidebar, with each box RIGHT-aligned so its
    // right edge lines up flush with the sidebar's left edge (consistent vertical seam).
    // Layout: [ ...right-aligned notif boxes (column 280) | sidebar (200) ] at the right edge.
    const SIDEBAR_W: f32 = 200.0;
    const NOTIF_W: f32 = 280.0;
    let viewport = ctx.viewport_rect();
    egui::Area::new("notifications".into())
        .fixed_pos(egui::pos2(viewport.max.x - SIDEBAR_W - NOTIF_W, 50.0))
        .show(&*ctx, |ui| {
            ui.set_width(NOTIF_W);
            ui.with_layout(egui::Layout::top_down(egui::Align::Max), |ui| {
                for (i, msg) in messages.iter().enumerate() {
                    let color = match msg.kind {
                        NotificationKind::Info => egui::Color32::LIGHT_BLUE,
                        NotificationKind::Warning => egui::Color32::YELLOW,
                        NotificationKind::Error => egui::Color32::LIGHT_RED,
                        NotificationKind::Achievement => egui::Color32::GOLD,
                    };

                    egui::Frame::popup(ui.style())
                        .fill(egui::Color32::from_rgba_unmultiplied(0, 0, 0, 200))
                        .stroke(egui::Stroke::new(1.0, color))
                        .show(ui, |ui| {
                            ui.colored_label(color, &msg.text);
                        });

                    if i < messages.len() - 1 {
                        ui.add_space(5.0);
                    }
                }
            });
        });
}
