//! The offscreen eye: a second camera that renders into an image asset instead of the
//! window, so a frame can be taken whether or not the window is on screen.
//!
//! Why not simply screenshot the window: macOS stops presenting a window that is hidden,
//! minimised or fully occluded, and the capture then comes back black. The old workflow
//! answered that by raising the window into the foreground before every shot — which is
//! exactly the screen-stealing this module exists to end. An image render target never
//! touches the swapchain, so it renders the same whether the window is frontmost, buried,
//! or absent.
//!
//! `simcity/capture` is a *watching* BRP method: the handler is polled once per frame and
//! answers `None` until the PNG is on disk, so a caller gets one blocking call and never
//! writes a sleep loop.

use std::collections::HashMap;
use std::path::Path;

use bevy::asset::RenderAssetUsages;
use bevy::camera::{ImageRenderTarget, RenderTarget};
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::image::Image;
use bevy::prelude::*;
use bevy::remote::{BrpError, BrpResult, error_codes};
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat, TextureUsages};
use bevy::render::view::screenshot::{Screenshot, ScreenshotCaptured};
use serde_json::{Value, json};
use simcity_core::game::camera::MainCamera;

use super::stats::FrameStats;
use bevy::ui::UiTargetCamera;
use bevy::window::PrimaryWindow;
use simcity_core::game::ui_state::GameUiRoot;

/// Default size of the offscreen target — 720p is enough to judge a scene and small
/// enough that a capture costs a few hundred kilobytes rather than five megabytes.
const DEFAULT_SIZE: UVec2 = UVec2::new(1280, 720);
/// Frames to let the render land before asking for the pixels. The eye camera is
/// activated on the first call, and a freshly activated camera has nothing in its target
/// until it has run through the render graph.
const DEFAULT_SETTLE_FRAMES: u32 = 3;
/// Frames an interface capture waits at least: layout and the glyph atlas need their first
/// frames after the eye switches on. An estimate until measured on a live instance.
const UI_SETTLE_FRAMES: u32 = 6;
/// Give up rather than hold a BRP request open forever if a frame never arrives.
const TIMEOUT_FRAMES: u32 = 900;
/// Largest side a capture may ask for. This is `wgpu`'s default
/// `max_texture_dimension_2d`, so beyond it the texture would be refused by the driver
/// anyway — refusing here turns a failure deep in the renderer into a plain answer.
const MAX_CAPTURE_SIZE: u32 = 8192;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/// Where the pixels come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureSource {
    /// The offscreen eye camera: the world as the main camera sees it, no egui on top,
    /// and no dependence on the window being visible.
    Offscreen,
    /// The primary window, egui and all. Needs the window to actually be presenting,
    /// so it is the wrong choice for a hidden instance — but the only way to see the UI.
    Window,
}

impl CaptureSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Offscreen => "offscreen",
            Self::Window => "window",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CaptureRequest {
    pub path: String,
    /// Only meaningful for [`CaptureSource::Offscreen`]; the window dictates its own size.
    pub size: Option<UVec2>,
    pub source: CaptureSource,
    pub settle_frames: u32,
    /// Retarget the game interface onto the eye for this capture. Offscreen only; takes the
    /// window's size and scale, so the layout is the one a player sees.
    pub ui: bool,
}

impl CaptureRequest {
    /// Parse the BRP params. Errors carry the reason a caller can act on, not a schema dump.
    pub fn parse(params: Option<&Value>) -> Result<Self, String> {
        let params = params.ok_or_else(|| {
            "capture needs params carrying at least a `path` to write the PNG to".to_string()
        })?;

        let path = params
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "capture needs a `path` to write the PNG to".to_string())?;
        if path.trim().is_empty() {
            return Err("`path` is empty".to_string());
        }
        // The caller picks the destination freely — this whole surface is dev-only and
        // already offers unauthenticated world mutation on the same port, so locking
        // captures into one directory would guard the smallest gap in a fence that has no
        // other sides, and would break the normal case of writing into a scratch dir
        // outside the repository. Insisting on the extension costs nothing and does rule
        // out quietly overwriting a config file with image bytes.
        if !Path::new(path)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
        {
            return Err(format!("`path` must end in .png, got {path:?}"));
        }

        let size = match (dimension(params, "width")?, dimension(params, "height")?) {
            (None, None) => None,
            (Some(width), Some(height)) => Some(UVec2::new(width, height)),
            (Some(_), None) => return Err("`width` was given without `height`".to_string()),
            (None, Some(_)) => return Err("`height` was given without `width`".to_string()),
        };

        let source = match params.get("source").and_then(Value::as_str) {
            None | Some("offscreen") => CaptureSource::Offscreen,
            Some("window") => CaptureSource::Window,
            Some(other) => {
                return Err(format!(
                    "unknown `source` {other:?} — expected \"offscreen\" or \"window\""
                ));
            }
        };

        let settle_frames = params
            .get("settle_frames")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_SETTLE_FRAMES, |frames| {
                frames.min(u64::from(TIMEOUT_FRAMES)) as u32
            });

        let ui = match params.get("ui") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(flag)) => *flag,
            Some(other) => return Err(format!("`ui` must be true or false, got {other}")),
        };
        if ui && source == CaptureSource::Window {
            return Err(
                "`ui` retargets the game interface onto the offscreen eye; a window \
                        capture already carries the interface"
                    .to_string(),
            );
        }
        if ui && size.is_some() {
            return Err(
                "a `ui` capture takes the window's size so the layout is the one a \
                        player sees; drop `width` and `height`"
                    .to_string(),
            );
        }
        let settle_frames = if ui {
            settle_frames.max(UI_SETTLE_FRAMES)
        } else {
            settle_frames
        };

        Ok(Self {
            path: path.to_string(),
            size,
            source,
            settle_frames,
            ui,
        })
    }
}

/// Read one side of a requested capture size.
///
/// The range is checked on the way in, before anything narrows: reading as `u64` and
/// casting afterwards let `2^32` past a test for zero and then made it zero, so a caller
/// could ask for a texture of no width and be told nothing was wrong. `u32::try_from`
/// puts the check and the type in the same place. A value out of range is also told apart
/// from an absent field — `as_u64` answers `None` to both, and reporting a negative width
/// as a missing one sends the caller hunting for a field they did supply.
fn dimension(params: &Value, key: &str) -> Result<Option<u32>, String> {
    let Some(value) = params.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }

    let side = value
        .as_u64()
        .and_then(|side| u32::try_from(side).ok())
        .ok_or_else(|| format!("`{key}` must be a whole number of pixels, got {value}"))?;

    if side == 0 {
        return Err(format!("`{key}` must be above zero"));
    }
    if side > MAX_CAPTURE_SIZE {
        return Err(format!(
            "`{key}` is {side}, above the {MAX_CAPTURE_SIZE} px a texture can be"
        ));
    }
    Ok(Some(side))
}

// ---------------------------------------------------------------------------
// Job state machine
// ---------------------------------------------------------------------------

/// What the handler should do on this frame. Keeping it a value rather than doing the work
/// inline is what makes the frame accounting testable without a rendering app.
#[derive(Debug, PartialEq)]
pub enum Step {
    /// First frame of this request: size the target and switch the eye on.
    Prepare,
    /// Keep the eye pointed where the main camera points and let the render land.
    Settle,
    /// The target holds a rendered frame — ask for the pixels.
    Shoot,
    /// Pixels are on their way back from the GPU.
    Wait,
    /// PNG is written; hand the caller its answer and switch the eye off.
    Done(CaptureOutcome),
    /// The capture failed for a reason worth reporting verbatim.
    Failed(String),
    /// No frame ever arrived.
    TimedOut,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CaptureOutcome {
    pub path: String,
    pub stats: FrameStats,
}

#[derive(Debug, PartialEq)]
enum Phase {
    New,
    Settling(u32),
    Capturing,
}

struct CaptureJob {
    phase: Phase,
    frames: u32,
    outcome: Option<Result<CaptureOutcome, String>>,
}

/// In-flight captures, keyed by destination path — two calls writing the same file are the
/// same job, two calls writing different files do not disturb each other.
#[derive(Resource, Default)]
pub struct CaptureJobs(HashMap<String, CaptureJob>);

impl CaptureJobs {
    /// Advance the job for `request` by one frame and say what the handler should do.
    pub fn advance(&mut self, request: &CaptureRequest) -> Step {
        let job = self
            .0
            .entry(request.path.clone())
            .or_insert_with(|| CaptureJob {
                phase: Phase::New,
                frames: 0,
                outcome: None,
            });

        job.frames += 1;
        if job.frames > TIMEOUT_FRAMES {
            self.0.remove(&request.path);
            return Step::TimedOut;
        }

        let step = match job.phase {
            Phase::New => {
                job.phase = Phase::Settling(request.settle_frames);
                Step::Prepare
            }
            Phase::Settling(0) => {
                job.phase = Phase::Capturing;
                Step::Shoot
            }
            Phase::Settling(remaining) => {
                job.phase = Phase::Settling(remaining - 1);
                Step::Settle
            }
            Phase::Capturing => match job.outcome.take() {
                None => Step::Wait,
                Some(Ok(outcome)) => Step::Done(outcome),
                Some(Err(reason)) => Step::Failed(reason),
            },
        };

        if matches!(step, Step::Done(_) | Step::Failed(_)) {
            self.0.remove(&request.path);
        }
        step
    }

    /// Called from the screenshot observer once the pixels are back.
    pub fn set_outcome(&mut self, path: &str, outcome: Result<CaptureOutcome, String>) {
        if let Some(job) = self.0.get_mut(path) {
            job.outcome = Some(outcome);
        }
    }

    #[cfg(test)]
    fn is_tracking(&self, path: &str) -> bool {
        self.0.contains_key(path)
    }
}

// ---------------------------------------------------------------------------
// The eye
// ---------------------------------------------------------------------------

/// Marks the eye camera so its queries never collide with the main camera's.
#[derive(Component)]
pub struct OffscreenEyeCamera;

/// The offscreen camera and the image it renders into.
#[derive(Resource)]
pub struct OffscreenEye {
    pub camera: Entity,
    pub image: Handle<Image>,
    pub size: UVec2,
}

/// Build the render-target image. `RENDER_WORLD` usage plus `COPY_SRC` is what lets the
/// screenshot machinery read it back.
fn new_target_image(size: UVec2) -> Image {
    let mut image = Image::new_fill(
        Extent3d {
            width: size.x,
            height: size.y,
            depth_or_array_layers: 1,
        },
        TextureDimension::D2,
        &[0, 0, 0, 255],
        TextureFormat::Bgra8UnormSrgb,
        RenderAssetUsages::RENDER_WORLD,
    );
    image.texture_descriptor.usage = TextureUsages::TEXTURE_BINDING
        | TextureUsages::COPY_SRC
        | TextureUsages::COPY_DST
        | TextureUsages::RENDER_ATTACHMENT;
    image
}

/// Spawn the eye inactive: two cameras rendering the same world every frame would double
/// the render cost for a capability used a few times a minute.
pub fn spawn_eye(mut commands: Commands, mut images: ResMut<Assets<Image>>) {
    let image = images.add(new_target_image(DEFAULT_SIZE));
    let camera = commands
        .spawn((
            Camera3d::default(),
            Camera {
                order: -1,
                is_active: false,
                ..default()
            },
            RenderTarget::Image(ImageRenderTarget::from(image.clone())),
            Projection::Orthographic(OrthographicProjection::default_3d()),
            Tonemapping::None,
            Transform::default(),
            OffscreenEyeCamera,
            Name::new("OffscreenEye"),
        ))
        .id();

    commands.insert_resource(OffscreenEye {
        camera,
        image,
        size: DEFAULT_SIZE,
    });
}

/// What the eye should be doing. The BRP handler only writes here; the camera itself is
/// touched by [`apply_eye_control`] in `PostUpdate`.
///
/// The indirection is not tidiness, it is the fix for a crash: remote handlers run in
/// `RemoteLast`, after `PostUpdate`, so a camera switched on there is extracted for
/// rendering before `build_directional_light_cascades` has ever seen it, and
/// `prepare_lights` panics unwrapping the cascades that were never built for it.
#[derive(Resource, Default)]
pub struct EyeControl {
    pub active: bool,
    pub size: Option<UVec2>,
    /// The game interface is retargeted onto the eye while it is active.
    pub ui: bool,
    /// Scale factor the eye's target takes for an interface capture.
    pub ui_scale: f32,
}

/// The pose the eye copies from. Spelled out as an alias because clippy rightly objects to
/// a four-line query type sitting in a parameter list.
type MainCameraView<'w, 's> = Query<
    'w,
    's,
    (
        &'static Transform,
        &'static Projection,
        Option<&'static AmbientLight>,
    ),
    (With<MainCamera>, Without<OffscreenEyeCamera>),
>;

/// The eye itself, mutable.
type EyeCameraView<'w, 's> = Query<
    'w,
    's,
    (
        Entity,
        &'static mut Camera,
        &'static mut Transform,
        &'static mut Projection,
    ),
    With<OffscreenEyeCamera>,
>;

/// Apply [`EyeControl`] and keep the eye pointed where the main camera points.
///
/// Scheduled before transform propagation and the camera update, hence before cascades:
/// activation, pose and projection all land in the same frame the renderer reads them.
///
/// Copying `AmbientLight` matters and is easy to miss: in this project it is a component
/// on the camera entity rather than a resource, so an eye without its own copy renders the
/// city lit by the sun alone and reads far darker than the window does.
pub fn apply_eye_control(
    control: Res<EyeControl>,
    mut images: ResMut<Assets<Image>>,
    mut eye: ResMut<OffscreenEye>,
    main: MainCameraView,
    mut eye_camera: EyeCameraView,
    mut commands: Commands,
) {
    let Ok((entity, mut camera, mut transform, mut projection)) = eye_camera.single_mut() else {
        return;
    };

    if let Some(size) = control.size
        && size != eye.size
        && let Some(mut image) = images.get_mut(&eye.image)
    {
        image.resize(Extent3d {
            width: size.x,
            height: size.y,
            depth_or_array_layers: 1,
        });
        eye.size = size;
    }

    camera.is_active = control.active;
    if !control.active {
        return;
    }

    let Ok((main_transform, main_projection, ambient)) = main.single() else {
        return;
    };
    *transform = *main_transform;
    *projection = main_projection.clone();
    match ambient {
        Some(ambient) => {
            commands.entity(entity).insert(ambient.clone());
        }
        None => {
            commands.entity(entity).remove::<AmbientLight>();
        }
    }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// `simcity/capture` — one call in, one PNG plus its statistics out.
/// The size and scale an interface capture renders at: the window's, shrunk together when the
/// window is larger than a texture can be, so the logical layout stays the player's.
pub fn ui_capture_size(physical: UVec2, scale_factor: f32) -> (UVec2, f32) {
    let longest = physical.x.max(physical.y);
    if longest <= MAX_CAPTURE_SIZE {
        return (physical, scale_factor);
    }
    let shrink = MAX_CAPTURE_SIZE as f32 / longest as f32;
    let side = |value: u32| ((value as f32 * shrink).round() as u32).clamp(1, MAX_CAPTURE_SIZE);
    (
        UVec2::new(side(physical.x), side(physical.y)),
        scale_factor * shrink,
    )
}

/// A game-interface root currently pointed at the eye, with the target it had before.
#[derive(Component, Debug, Clone, Copy)]
pub struct RetargetedForCapture {
    pub previous: Option<Entity>,
}

/// Game-interface roots with their own target, if any, and the target they had before a capture.
type GameUiRoots<'w, 's> = Query<
    'w,
    's,
    (
        Entity,
        Option<&'static UiTargetCamera>,
        Option<&'static RetargetedForCapture>,
    ),
    With<GameUiRoot>,
>;

/// Point the game interface at the eye while it captures, and put it back afterwards.
///
/// Retargets the real roots rather than drawing a copy: hover, pressed and focus live on the
/// original entities, so a copy would show a different interface from the one being judged. A
/// root that had no target of its own gets none back — pinning it to the main camera would take
/// it out of the default camera selection for good.
pub fn retarget_game_ui_to_eye(
    control: Res<EyeControl>,
    eye: Option<Res<OffscreenEye>>,
    roots: GameUiRoots,
    mut targets: Query<&mut RenderTarget, With<OffscreenEyeCamera>>,
    mut commands: Commands,
) {
    let Some(eye) = eye else {
        return;
    };

    if control.active && control.ui {
        for (root, target, retargeted) in &roots {
            if retargeted.is_none() {
                commands.entity(root).insert((
                    UiTargetCamera(eye.camera),
                    RetargetedForCapture {
                        previous: target.map(|target| target.0),
                    },
                ));
            }
        }
        set_eye_scale(&mut targets, control.ui_scale);
        return;
    }

    let mut restored = false;
    for (root, _, retargeted) in &roots {
        let Some(retargeted) = retargeted else {
            continue;
        };
        let mut entity = commands.entity(root);
        match retargeted.previous {
            Some(camera) => {
                entity.insert(UiTargetCamera(camera));
            }
            None => {
                entity.remove::<UiTargetCamera>();
            }
        }
        entity.remove::<RetargetedForCapture>();
        restored = true;
    }
    if restored {
        set_eye_scale(&mut targets, 1.0);
    }
}

/// Write the eye's target scale only when it differs, so the target is not marked changed on
/// every frame of a capture.
fn set_eye_scale(targets: &mut Query<&mut RenderTarget, With<OffscreenEyeCamera>>, scale: f32) {
    for mut target in targets.iter_mut() {
        let differs = matches!(
            &*target,
            RenderTarget::Image(image) if (image.scale_factor - scale).abs() > f32::EPSILON
        );
        if differs && let RenderTarget::Image(image) = &mut *target {
            image.scale_factor = scale;
        }
    }
}

pub fn capture_handler(
    In(params): In<Option<Value>>,
    world: &mut World,
) -> BrpResult<Option<Value>> {
    let request = CaptureRequest::parse(params.as_ref()).map_err(invalid_params)?;

    let step = world.resource_scope(|_world, mut jobs: Mut<CaptureJobs>| jobs.advance(&request));

    match step {
        Step::Prepare => {
            if request.source == CaptureSource::Offscreen {
                let window = world
                    .query_filtered::<&Window, With<PrimaryWindow>>()
                    .iter(world)
                    .next()
                    .map(|window| {
                        (
                            UVec2::new(
                                window.resolution.physical_width(),
                                window.resolution.physical_height(),
                            ),
                            window.resolution.scale_factor(),
                        )
                    });
                let mut control = world.resource_mut::<EyeControl>();
                if request.ui {
                    let (physical, scale) = window.unwrap_or((DEFAULT_SIZE, 1.0));
                    let (size, scale) = ui_capture_size(physical, scale);
                    control.size = Some(size);
                    control.ui = true;
                    control.ui_scale = scale;
                } else {
                    control.size = Some(request.size.unwrap_or(DEFAULT_SIZE));
                    control.ui = false;
                }
                control.active = true;
            }
            Ok(None)
        }
        Step::Settle => Ok(None),
        Step::Shoot => {
            shoot(world, &request);
            Ok(None)
        }
        Step::Wait => Ok(None),
        Step::Done(outcome) => {
            world.resource_mut::<EyeControl>().active = false;
            Ok(Some(json!({
                "path": outcome.path,
                "source": request.source.as_str(),
                "stats": outcome.stats,
                "looks_rendered": outcome.stats.looks_rendered(),
            })))
        }
        Step::Failed(reason) => {
            world.resource_mut::<EyeControl>().active = false;
            Err(capture_error(reason))
        }
        Step::TimedOut => {
            world.resource_mut::<EyeControl>().active = false;
            Err(capture_error(format!(
                "no frame arrived within {TIMEOUT_FRAMES} frames"
            )))
        }
    }
}

/// Ask the renderer for the pixels and arrange for the answer to land back in [`CaptureJobs`].
fn shoot(world: &mut World, request: &CaptureRequest) {
    let screenshot = match request.source {
        CaptureSource::Offscreen => {
            let Some(eye) = world.get_resource::<OffscreenEye>() else {
                world
                    .resource_mut::<CaptureJobs>()
                    .set_outcome(&request.path, Err("offscreen eye is not spawned".into()));
                return;
            };
            Screenshot::image(eye.image.clone())
        }
        CaptureSource::Window => Screenshot::primary_window(),
    };

    let key = request.path.clone();
    world.spawn(screenshot).observe(
        move |captured: On<ScreenshotCaptured>, mut jobs: ResMut<CaptureJobs>| {
            let outcome = write_png(&key, &captured.image);
            jobs.set_outcome(&key, outcome);
        },
    );
}

/// Encode, measure and write in one pass, so the statistics describe exactly the bytes
/// that reached the disk.
fn write_png(path: &str, image: &Image) -> Result<CaptureOutcome, String> {
    let dynamic = image
        .clone()
        .try_into_dynamic()
        .map_err(|err| format!("captured frame is not convertible to an image: {err}"))?;
    let rgb = dynamic.to_rgb8();
    let (width, height) = rgb.dimensions();
    let stats = FrameStats::from_rgb8(width, height, rgb.as_raw())
        .ok_or_else(|| "captured frame buffer disagrees with its own dimensions".to_string())?;

    if let Some(parent) = Path::new(path).parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("cannot create {}: {err}", parent.display()))?;
    }
    rgb.save(path)
        .map_err(|err| format!("cannot write {path}: {err}"))?;

    Ok(CaptureOutcome {
        path: path.to_string(),
        stats,
    })
}

fn invalid_params(message: String) -> BrpError {
    BrpError {
        code: error_codes::INVALID_PARAMS,
        message,
        data: None,
    }
}

fn capture_error(message: String) -> BrpError {
    BrpError {
        code: error_codes::INTERNAL_ERROR,
        message,
        data: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str) -> CaptureRequest {
        CaptureRequest {
            path: path.to_string(),
            size: None,
            source: CaptureSource::Offscreen,
            settle_frames: 2,
            ui: false,
        }
    }

    fn stats() -> FrameStats {
        FrameStats {
            width: 4,
            height: 4,
            mean: 100.0,
            std: 40.0,
            min: 0,
            max: 255,
            nonblack_fraction: 0.9,
        }
    }

    #[test]
    fn parse_requires_a_path() {
        let err = CaptureRequest::parse(Some(&json!({}))).unwrap_err();
        assert!(
            err.contains("path"),
            "error should name the missing field: {err}"
        );
    }

    #[test]
    fn parse_insists_the_destination_is_a_png() {
        for bad in ["/tmp/a.txt", "/tmp/a", "/Users/someone/.zshrc"] {
            let err = CaptureRequest::parse(Some(&json!({ "path": bad }))).unwrap_err();
            assert!(
                err.contains(".png"),
                "{bad:?} should be refused for not being a png: {err}"
            );
        }
        assert!(CaptureRequest::parse(Some(&json!({ "path": "/tmp/a.PNG" }))).is_ok());
    }

    #[test]
    fn parse_defaults_to_the_offscreen_eye() {
        let parsed = CaptureRequest::parse(Some(&json!({ "path": "/tmp/a.png" }))).unwrap();
        assert_eq!(parsed.source, CaptureSource::Offscreen);
        assert_eq!(parsed.size, None);
        assert_eq!(parsed.settle_frames, DEFAULT_SETTLE_FRAMES);
    }

    #[test]
    fn parse_reads_size_and_source() {
        let parsed = CaptureRequest::parse(Some(&json!({
            "path": "/tmp/a.png",
            "width": 640,
            "height": 360,
            "source": "window",
        })))
        .unwrap();
        assert_eq!(parsed.size, Some(UVec2::new(640, 360)));
        assert_eq!(parsed.source, CaptureSource::Window);
    }

    #[test]
    fn parse_rejects_a_size_that_would_truncate_to_zero() {
        // 2^32 is not zero as a u64, so a check that runs before the cast lets it through
        // and the cast then makes it zero — a texture of no width, asked for politely.
        let err = CaptureRequest::parse(Some(&json!({
            "path": "/tmp/a.png",
            "width": 4_294_967_296u64,
            "height": 720,
        })))
        .unwrap_err();
        assert!(
            err.contains("width"),
            "the error should name the field: {err}"
        );
    }

    #[test]
    fn parse_rejects_a_size_past_what_a_texture_can_be() {
        let err = CaptureRequest::parse(Some(&json!({
            "path": "/tmp/a.png",
            "width": 100_000,
            "height": 100_000,
        })))
        .unwrap_err();
        assert!(
            err.contains(&MAX_CAPTURE_SIZE.to_string()),
            "the error should name the limit: {err}"
        );
    }

    #[test]
    fn parse_accepts_the_limit_itself() {
        let parsed = CaptureRequest::parse(Some(&json!({
            "path": "/tmp/a.png",
            "width": MAX_CAPTURE_SIZE,
            "height": MAX_CAPTURE_SIZE,
        })))
        .expect("the limit is a usable size");
        assert_eq!(
            parsed.size,
            Some(UVec2::new(MAX_CAPTURE_SIZE, MAX_CAPTURE_SIZE))
        );
    }

    #[test]
    fn parse_says_what_is_wrong_with_a_negative_size() {
        // `as_u64` answers `None` for a negative number exactly as it does for an absent
        // field, so a naive reading reports "width was given without height" — which sends
        // the caller looking for a field they did supply.
        let err = CaptureRequest::parse(Some(&json!({
            "path": "/tmp/a.png",
            "width": -8,
            "height": 720,
        })))
        .unwrap_err();
        assert!(
            err.contains("width") && !err.contains("without"),
            "the error should be about the bad width, not about a missing field: {err}"
        );
    }

    #[test]
    fn parse_rejects_half_a_size() {
        let err = CaptureRequest::parse(Some(&json!({ "path": "/tmp/a.png", "width": 640 })))
            .unwrap_err();
        assert!(
            err.contains("height"),
            "error should name what is missing: {err}"
        );
    }

    #[test]
    fn parse_rejects_an_unknown_source() {
        let err = CaptureRequest::parse(Some(
            &json!({ "path": "/tmp/a.png", "source": "telepathy" }),
        ))
        .unwrap_err();
        assert!(
            err.contains("telepathy"),
            "error should quote the bad value: {err}"
        );
    }

    #[test]
    fn a_capture_walks_prepare_settle_shoot_wait_done() {
        let mut jobs = CaptureJobs::default();
        let request = request("/tmp/shot.png");

        assert_eq!(jobs.advance(&request), Step::Prepare);
        assert_eq!(jobs.advance(&request), Step::Settle);
        assert_eq!(jobs.advance(&request), Step::Settle);
        assert_eq!(jobs.advance(&request), Step::Shoot);
        assert_eq!(jobs.advance(&request), Step::Wait);

        jobs.set_outcome(
            "/tmp/shot.png",
            Ok(CaptureOutcome {
                path: "/tmp/shot.png".into(),
                stats: stats(),
            }),
        );

        match jobs.advance(&request) {
            Step::Done(outcome) => assert_eq!(outcome.stats, stats()),
            other => panic!("expected the capture to finish, got {other:?}"),
        }
        assert!(
            !jobs.is_tracking("/tmp/shot.png"),
            "a finished job is forgotten"
        );
    }

    #[test]
    fn a_failure_from_the_observer_reaches_the_caller() {
        let mut jobs = CaptureJobs::default();
        let request = CaptureRequest {
            settle_frames: 0,
            ..request("/tmp/bad.png")
        };

        assert_eq!(jobs.advance(&request), Step::Prepare);
        assert_eq!(jobs.advance(&request), Step::Shoot);
        jobs.set_outcome("/tmp/bad.png", Err("disk is full".into()));

        assert_eq!(jobs.advance(&request), Step::Failed("disk is full".into()));
        assert!(!jobs.is_tracking("/tmp/bad.png"));
    }

    #[test]
    fn two_destinations_are_two_independent_jobs() {
        let mut jobs = CaptureJobs::default();
        let first = request("/tmp/one.png");
        let second = request("/tmp/two.png");

        assert_eq!(jobs.advance(&first), Step::Prepare);
        assert_eq!(jobs.advance(&second), Step::Prepare);
        assert_eq!(jobs.advance(&first), Step::Settle);
        assert_eq!(jobs.advance(&second), Step::Settle);
    }

    #[test]
    fn a_frame_that_never_arrives_times_out() {
        let mut jobs = CaptureJobs::default();
        let request = CaptureRequest {
            settle_frames: 0,
            ..request("/tmp/never.png")
        };

        let mut step = jobs.advance(&request);
        let mut frames = 1;
        while step != Step::TimedOut {
            assert!(
                frames <= TIMEOUT_FRAMES + 2,
                "the job should have given up by now"
            );
            step = jobs.advance(&request);
            frames += 1;
        }
        assert!(
            !jobs.is_tracking("/tmp/never.png"),
            "a timed-out job is forgotten"
        );
    }
    #[test]
    fn parse_reads_the_ui_flag() {
        let request =
            CaptureRequest::parse(Some(&json!({ "path": "/tmp/a.png", "ui": true }))).unwrap();
        assert!(request.ui);
        assert!(
            request.settle_frames >= UI_SETTLE_FRAMES,
            "an interface capture waits for layout and glyphs"
        );
    }

    #[test]
    fn parse_refuses_a_ui_flag_that_is_not_a_bool() {
        let err =
            CaptureRequest::parse(Some(&json!({ "path": "/tmp/a.png", "ui": "yes" }))).unwrap_err();
        assert!(err.contains("`ui`"), "{err}");
    }

    #[test]
    fn parse_refuses_ui_on_a_window_capture() {
        let err = CaptureRequest::parse(Some(
            &json!({ "path": "/tmp/a.png", "ui": true, "source": "window" }),
        ))
        .unwrap_err();
        assert!(err.contains("window"), "{err}");
    }

    #[test]
    fn parse_refuses_ui_with_an_explicit_size() {
        let err = CaptureRequest::parse(Some(
            &json!({ "path": "/tmp/a.png", "ui": true, "width": 800, "height": 600 }),
        ))
        .unwrap_err();
        assert!(err.contains("width"), "{err}");
    }

    #[test]
    fn a_ui_capture_takes_the_window_size_and_scale() {
        assert_eq!(
            ui_capture_size(UVec2::new(4000, 2000), 2.0),
            (UVec2::new(4000, 2000), 2.0)
        );
    }

    #[test]
    fn a_ui_capture_larger_than_a_texture_shrinks_size_and_scale_together() {
        let (size, scale) = ui_capture_size(UVec2::new(10_000, 5_000), 2.0);
        assert_eq!(size, UVec2::new(MAX_CAPTURE_SIZE, 4096));
        let expected = 2.0 * MAX_CAPTURE_SIZE as f32 / 10_000.0;
        assert!(
            (scale - expected).abs() < 1e-4,
            "the logical layout must stay the player's: scale {scale}, expected {expected}"
        );
    }

    fn eye_scale(world: &World, eye: Entity) -> f32 {
        match world.get::<RenderTarget>(eye) {
            Some(RenderTarget::Image(target)) => target.scale_factor,
            _ => panic!("the eye must render into an image"),
        }
    }

    #[test]
    fn game_ui_roots_follow_the_eye_while_it_captures_and_come_back_after() {
        let mut app = App::new();
        let main = app.world_mut().spawn_empty().id();
        let eye = app
            .world_mut()
            .spawn((
                OffscreenEyeCamera,
                RenderTarget::Image(ImageRenderTarget::from(Handle::<Image>::default())),
            ))
            .id();
        app.insert_resource(OffscreenEye {
            camera: eye,
            image: Handle::default(),
            size: DEFAULT_SIZE,
        });
        app.insert_resource(EyeControl {
            active: true,
            size: None,
            ui: true,
            ui_scale: 2.0,
        });
        let free = app.world_mut().spawn(GameUiRoot).id();
        let pinned = app
            .world_mut()
            .spawn((GameUiRoot, UiTargetCamera(main)))
            .id();
        let unrelated = app.world_mut().spawn(UiTargetCamera(main)).id();
        app.add_systems(Update, retarget_game_ui_to_eye);

        app.update();
        let world = app.world();
        assert_eq!(world.get::<UiTargetCamera>(free).map(|t| t.0), Some(eye));
        assert_eq!(world.get::<UiTargetCamera>(pinned).map(|t| t.0), Some(eye));
        assert_eq!(
            world.get::<UiTargetCamera>(unrelated).map(|t| t.0),
            Some(main),
            "only game-interface roots move"
        );
        assert!(
            (eye_scale(world, eye) - 2.0).abs() < 1e-6,
            "eye takes the window scale"
        );

        app.world_mut().resource_mut::<EyeControl>().active = false;
        app.update();
        let world = app.world();
        assert!(
            world.get::<UiTargetCamera>(free).is_none(),
            "a root that had no target gets none back, not the main camera"
        );
        assert_eq!(world.get::<UiTargetCamera>(pinned).map(|t| t.0), Some(main));
        assert!(
            world.get::<RetargetedForCapture>(free).is_none(),
            "the bookkeeping is cleared once the interface is back"
        );
        assert!(
            (eye_scale(world, eye) - 1.0).abs() < 1e-6,
            "eye scale goes back to 1.0"
        );
    }
}
