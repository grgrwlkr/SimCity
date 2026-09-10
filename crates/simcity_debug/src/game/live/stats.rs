//! Frame statistics computed inside the game.
//!
//! The point is that a caller never has to shell out to ImageMagick to answer the one
//! question that matters after a capture: is this a real frame, or did the GPU hand us a
//! black rectangle? `FrameStats` travels back in the BRP response, so a single call both
//! writes the PNG and says whether it is worth looking at.

use serde::Serialize;

/// Luma at or below this counts as black; a frame that was never presented comes back as
/// exact zeros, so the threshold only has to survive dither noise.
const BLACK_LUMA: f32 = 8.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct FrameStats {
    pub width: u32,
    pub height: u32,
    /// Mean luma over the frame, 0..255.
    pub mean: f32,
    /// Standard deviation of luma. A presented frame of a city sits well above 1.0;
    /// a black or single-colour frame sits at 0.
    pub std: f32,
    pub min: u8,
    pub max: u8,
    /// Share of pixels brighter than [`BLACK_LUMA`], 0.0..1.0.
    pub nonblack_fraction: f32,
}

impl FrameStats {
    /// Compute stats over a tightly packed RGB8 buffer.
    ///
    /// Returns `None` when the buffer length disagrees with the declared size — the only
    /// way a caller could be handed numbers describing a frame that was not there.
    pub fn from_rgb8(width: u32, height: u32, rgb: &[u8]) -> Option<Self> {
        let pixels = (width as usize).checked_mul(height as usize)?;
        if pixels == 0 || rgb.len() != pixels * 3 {
            return None;
        }

        let mut sum = 0.0f64;
        let mut min = f32::MAX;
        let mut max = f32::MIN;
        let mut nonblack = 0usize;
        for pixel in rgb.chunks_exact(3) {
            let value = luma(pixel[0], pixel[1], pixel[2]);
            sum += f64::from(value);
            min = min.min(value);
            max = max.max(value);
            if value > BLACK_LUMA {
                nonblack += 1;
            }
        }
        let count = pixels as f64;
        let mean = sum / count;

        // Second pass rather than the sum-of-squares shortcut: on a flat frame the
        // shortcut leaves float dust where the answer is exactly zero, and "is the spread
        // exactly zero" is the question this struct exists to answer.
        let mut variance = 0.0f64;
        for pixel in rgb.chunks_exact(3) {
            let delta = f64::from(luma(pixel[0], pixel[1], pixel[2])) - mean;
            variance += delta * delta;
        }
        variance /= count;

        Some(Self {
            width,
            height,
            mean: mean as f32,
            std: variance.sqrt() as f32,
            min: min.round() as u8,
            max: max.round() as u8,
            nonblack_fraction: (nonblack as f64 / count) as f32,
        })
    }

    /// A frame worth looking at: presented, and not one flat colour.
    pub fn looks_rendered(&self) -> bool {
        self.std > 1.0 && self.nonblack_fraction > 0.01
    }
}

/// Rec. 601 luma — the same weighting the eye applies when judging "is this black".
fn luma(r: u8, g: u8, b: u8) -> f32 {
    0.299 * f32::from(r) + 0.587 * f32::from(g) + 0.114 * f32::from(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
        (0..width * height).flat_map(|_| rgb).collect()
    }

    #[test]
    fn black_frame_is_not_rendered() {
        let buf = solid(4, 4, [0, 0, 0]);
        let stats = FrameStats::from_rgb8(4, 4, &buf).expect("size matches");
        assert_eq!(stats.mean, 0.0);
        assert_eq!(stats.std, 0.0);
        assert_eq!(stats.nonblack_fraction, 0.0);
        assert!(!stats.looks_rendered());
    }

    #[test]
    fn flat_grey_frame_is_bright_but_not_rendered() {
        let buf = solid(4, 4, [128, 128, 128]);
        let stats = FrameStats::from_rgb8(4, 4, &buf).expect("size matches");
        assert!((stats.mean - 128.0).abs() < 0.5);
        assert_eq!(stats.std, 0.0);
        assert_eq!(stats.nonblack_fraction, 1.0);
        assert!(!stats.looks_rendered(), "one flat colour is not a scene");
    }

    #[test]
    fn checkerboard_frame_reads_as_rendered() {
        let mut buf = Vec::new();
        for i in 0..16u32 {
            let v = if i % 2 == 0 { 0 } else { 255 };
            buf.extend_from_slice(&[v, v, v]);
        }
        let stats = FrameStats::from_rgb8(4, 4, &buf).expect("size matches");
        assert!((stats.mean - 127.5).abs() < 1.0);
        assert!(stats.std > 100.0, "half black half white has a huge spread");
        assert_eq!(stats.min, 0);
        assert_eq!(stats.max, 255);
        assert!((stats.nonblack_fraction - 0.5).abs() < f32::EPSILON);
        assert!(stats.looks_rendered());
    }

    #[test]
    fn truncated_buffer_is_rejected() {
        let buf = solid(4, 4, [10, 20, 30]);
        assert!(FrameStats::from_rgb8(4, 5, &buf).is_none());
    }

    #[test]
    fn luma_weights_green_heaviest() {
        assert!(luma(0, 255, 0) > luma(255, 0, 0));
        assert!(luma(255, 0, 0) > luma(0, 0, 255));
    }
}
