use bevy::prelude::*;
use bevy::remote::{BrpReceiver, RemoteLast, RemoteSystems};
use bevy::time::Real;

/// Time window in seconds to consider MCP activity as active.
pub const MCP_ACTIVE_WINDOW_S: f32 = 2.0;
/// Time window in seconds to consider MCP activity as recently idle.
pub const MCP_IDLE_WINDOW_S: f32 = 30.0;

/// Tracks recent BRP activity to approximate MCP connectivity.
#[derive(Resource, Debug, Clone, Default)]
pub struct McpConnectionStatus {
    /// True when `RemotePlugin` initialized its receiver.
    pub remote_enabled: bool,
    /// Last observed request timestamp in seconds since startup.
    pub last_request_at_s: Option<f32>,
    /// Pending requests observed before BRP processing.
    pub pending_requests: usize,
}

/// Plugin that records incoming BRP activity for UI display.
pub struct McpStatusPlugin;

impl Plugin for McpStatusPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<McpConnectionStatus>().add_systems(
            RemoteLast,
            track_brp_activity.before(RemoteSystems::ProcessRequests),
        );
    }
}

/// System that observes pending BRP requests without consuming them.
fn track_brp_activity(
    time: Res<Time<Real>>,
    receiver: Option<Res<BrpReceiver>>,
    mut status: ResMut<McpConnectionStatus>,
) {
    status.remote_enabled = receiver.is_some();
    let Some(receiver) = receiver else {
        status.pending_requests = 0;
        return;
    };

    let pending = receiver.len();
    status.pending_requests = pending;
    if pending > 0 {
        status.last_request_at_s = Some(time.elapsed_secs());
    }
}
