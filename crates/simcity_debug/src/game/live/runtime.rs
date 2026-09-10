//! How a live-debug instance is launched: which BRP port it answers on, whether its window
//! is on screen at all, and whether it keeps simulating when nothing is focused on it.
//!
//! All three are read from the environment rather than from flags, because the launcher on
//! the other side is `bevy_brp_mcp`, which sets `BRP_EXTRAS_PORT` and nothing else.
//!
//! The window mode is the part that makes parallel work bearable: a hidden instance never
//! takes the screen, never takes focus, and never argues
//! with whoever is at the keyboard, while the offscreen eye keeps producing frames
//! exactly as it does for a visible one.

use bevy::prelude::*;
use bevy::winit::WinitSettings;

/// Port the BRP HTTP transport listens on when nothing says otherwise.
pub const DEFAULT_PORT: u16 = 15702;
/// Names the port; the same variable `bevy_brp_mcp` sets when it launches an app.
pub const PORT_VAR: &str = "BRP_EXTRAS_PORT";
/// Names the window mode.
pub const WINDOW_VAR: &str = "SIMCITY_WINDOW";

/// Whether the instance puts a window on the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WindowMode {
    /// A normal window, for a human to look at.
    #[default]
    Normal,
    /// No window on screen. The app still runs, still renders, still answers BRP — and
    /// never takes focus, which is the entire point.
    Hidden,
}

impl WindowMode {
    /// What to put in `Window::visible`.
    pub fn visible(self) -> bool {
        matches!(self, Self::Normal)
    }
}

/// Everything the launch environment says about this instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiveRuntimeConfig {
    pub port: u16,
    pub window: WindowMode,
}

impl Default for LiveRuntimeConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            window: WindowMode::Normal,
        }
    }
}

impl LiveRuntimeConfig {
    /// Read the configuration from the real process environment.
    pub fn from_env() -> Self {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    /// Same, against any source of variables — which is what makes it testable.
    ///
    /// A malformed value is a warning and a default, never a refusal to start: an instance
    /// that fails to boot over a typo in an environment variable is worse than one that
    /// boots on the default port and says so.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Self {
        let port = match var(PORT_VAR) {
            None => DEFAULT_PORT,
            Some(raw) => match raw.trim().parse::<u16>() {
                Ok(port) if port > 0 => port,
                _ => {
                    warn!("{PORT_VAR}={raw:?} is not a usable port — staying on {DEFAULT_PORT}");
                    DEFAULT_PORT
                }
            },
        };

        let window = match var(WINDOW_VAR) {
            None => WindowMode::Normal,
            Some(raw) => match raw.trim().to_ascii_lowercase().as_str() {
                "hidden" => WindowMode::Hidden,
                "normal" | "" => WindowMode::Normal,
                _ => {
                    warn!("{WINDOW_VAR}={raw:?} is not a window mode — showing a normal window");
                    WindowMode::Normal
                }
            },
        };

        Self { port, window }
    }
}

/// Keep updating at full rate even when the app has no focus.
///
/// Bevy's default for a game drops an unfocused app to `reactive_low_power` at 60 Hz,
/// which is right for a game a person is playing and wrong for an instance that exists to
/// be driven remotely: a hidden window is unfocused by definition and receives no redraw
/// requests, so without this the loop would idle exactly when nobody is watching it.
pub fn continuous_update_settings() -> WinitSettings {
    WinitSettings::continuous()
}

#[cfg(test)]
mod tests {
    use bevy::winit::UpdateMode;

    use super::*;

    /// A stand-in environment: a lookup over a fixed list of pairs.
    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect();
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn an_empty_environment_gives_a_visible_window_on_the_default_port() {
        let config = LiveRuntimeConfig::from_vars(vars(&[]));
        assert_eq!(config.port, DEFAULT_PORT);
        assert_eq!(config.window, WindowMode::Normal);
        assert!(config.window.visible());
    }

    #[test]
    fn the_port_comes_from_the_variable_the_mcp_launcher_sets() {
        let config = LiveRuntimeConfig::from_vars(vars(&[(PORT_VAR, "15777")]));
        assert_eq!(config.port, 15777);
    }

    #[test]
    fn a_nonsense_port_falls_back_rather_than_refusing_to_start() {
        for bad in ["", "0", "not-a-port", "99999999"] {
            let config = LiveRuntimeConfig::from_vars(vars(&[(PORT_VAR, bad)]));
            assert_eq!(
                config.port, DEFAULT_PORT,
                "{bad:?} should fall back to the default port"
            );
        }
    }

    #[test]
    fn hidden_is_asked_for_by_name_and_is_case_insensitive() {
        for spelling in ["hidden", "Hidden", "HIDDEN", " hidden "] {
            let config = LiveRuntimeConfig::from_vars(vars(&[(WINDOW_VAR, spelling)]));
            assert_eq!(
                config.window,
                WindowMode::Hidden,
                "{spelling:?} should mean hidden"
            );
            assert!(!config.window.visible());
        }
    }

    #[test]
    fn an_unknown_window_mode_leaves_the_window_visible() {
        let config = LiveRuntimeConfig::from_vars(vars(&[(WINDOW_VAR, "invisible-ish")]));
        assert_eq!(config.window, WindowMode::Normal);
    }

    #[test]
    fn port_and_window_are_read_independently() {
        let config =
            LiveRuntimeConfig::from_vars(vars(&[(PORT_VAR, "15801"), (WINDOW_VAR, "hidden")]));
        assert_eq!(config.port, 15801);
        assert_eq!(config.window, WindowMode::Hidden);
    }

    #[test]
    fn an_unfocused_instance_is_not_throttled() {
        let settings = continuous_update_settings();
        assert!(matches!(settings.unfocused_mode, UpdateMode::Continuous));
        assert!(matches!(settings.focused_mode, UpdateMode::Continuous));
    }
}
