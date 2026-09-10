//! The game interface's visual language, as tokens.
//!
//! Every colour, size and spacing the game interface uses comes from here, so the interface reads
//! as one system rather than a set of default widgets. A value that is not a token is a defect.

use bevy::prelude::*;

/// Colours. Text colours are chosen against the glass they sit on, not against the screen.
#[derive(Debug, Clone, Copy)]
pub struct Palette {
    /// Primary text on glass.
    pub ink: Color,
    /// Secondary text on glass: labels, units, hints.
    pub ink_muted: Color,
    /// Glass fill, with the alpha the world shows through.
    pub glass: Color,
    /// Thin light edge along the top of a glass panel.
    pub glass_highlight: Color,
    /// Glass outline.
    pub glass_border: Color,
    /// The selected tool, the active overlay, a focused control.
    pub accent: Color,
    /// Money rising, a valid placement.
    pub positive: Color,
    /// Money falling, an invalid placement.
    pub negative: Color,
    /// Something that needs attention soon.
    pub warning: Color,
}

/// Spacing, in multiples of one grid unit.
#[derive(Debug, Clone, Copy)]
pub struct Spacing {
    pub unit: f32,
}

impl Spacing {
    pub fn px(self, units: f32) -> Val {
        Val::Px(self.unit * units)
    }
}

/// Corner radii.
#[derive(Debug, Clone, Copy)]
pub struct Radii {
    pub panel: f32,
    pub control: f32,
}

/// Type sizes, in logical pixels.
#[derive(Debug, Clone, Copy)]
pub struct TypeScale {
    pub caption: f32,
    pub body: f32,
    pub title: f32,
    pub display: f32,
}

/// The whole visual language.
#[derive(Resource, Debug, Clone, Copy)]
pub struct Theme {
    pub palette: Palette,
    pub space: Spacing,
    pub radii: Radii,
    pub type_scale: TypeScale,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            // Smoked glass: dark enough that light text holds WCAG AA over sunlit concrete, open
            // enough that a fifth of the city shows through. The tests below hold both ends.
            palette: Palette {
                ink: Color::srgb(0.95, 0.96, 0.98),
                ink_muted: Color::srgb(0.70, 0.73, 0.78),
                glass: Color::srgba(0.06, 0.08, 0.11, 0.8),
                glass_highlight: Color::srgba(1.0, 1.0, 1.0, 0.10),
                glass_border: Color::srgba(1.0, 1.0, 1.0, 0.12),
                accent: Color::srgb(0.36, 0.62, 1.0),
                positive: Color::srgb(0.45, 0.85, 0.55),
                negative: Color::srgb(1.0, 0.45, 0.42),
                warning: Color::srgb(1.0, 0.78, 0.30),
            },
            space: Spacing { unit: 4.0 },
            radii: Radii {
                panel: 12.0,
                control: 8.0,
            },
            type_scale: TypeScale {
                caption: 12.0,
                body: 14.0,
                title: 18.0,
                display: 24.0,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WCAG 2 relative luminance, from linear sRGB.
    fn luminance(color: Color) -> f32 {
        let c = color.to_linear();
        0.2126 * c.red + 0.7152 * c.green + 0.0722 * c.blue
    }

    fn contrast(a: Color, b: Color) -> f32 {
        let (la, lb) = (luminance(a), luminance(b));
        let (hi, lo) = if la > lb { (la, lb) } else { (lb, la) };
        (hi + 0.05) / (lo + 0.05)
    }

    /// What the eye sees behind text: the glass laid over the world, blended in linear light.
    fn over(glass: Color, world: Color) -> Color {
        let g = glass.to_linear();
        let w = world.to_linear();
        let a = g.alpha;
        Color::LinearRgba(LinearRgba::new(
            g.red * a + w.red * (1.0 - a),
            g.green * a + w.green * (1.0 - a),
            g.blue * a + w.blue * (1.0 - a),
            1.0,
        ))
    }

    /// The darkest and brightest worlds the interface sits over: a night street and sunlit
    /// concrete in the stylised-realism palette.
    fn worlds() -> [(&'static str, Color); 2] {
        [
            ("night street", Color::srgb(0.05, 0.06, 0.08)),
            ("sunlit concrete", Color::srgb(0.75, 0.75, 0.72)),
        ]
    }

    #[test]
    fn ui_shell_body_text_is_readable_on_glass_over_any_world() {
        let theme = Theme::default();
        for (name, world) in worlds() {
            let ratio = contrast(theme.palette.ink, over(theme.palette.glass, world));
            assert!(
                ratio >= 4.5,
                "body text over glass over the {name} reads at {ratio:.2}:1, below WCAG AA 4.5:1"
            );
        }
    }

    #[test]
    fn ui_shell_muted_text_stays_readable_on_glass_over_any_world() {
        let theme = Theme::default();
        for (name, world) in worlds() {
            let ratio = contrast(theme.palette.ink_muted, over(theme.palette.glass, world));
            assert!(
                ratio >= 3.0,
                "muted text over glass over the {name} reads at {ratio:.2}:1, below 3:1"
            );
        }
    }

    #[test]
    fn ui_shell_glass_lets_the_world_show_through() {
        // Glass that is opaque is a flat fill, which D10 rules out.
        let alpha = Theme::default().palette.glass.to_linear().alpha;
        assert!(
            (0.5..0.95).contains(&alpha),
            "glass alpha {alpha} is not translucent glass"
        );
    }
}
