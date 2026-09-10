#import bevy_render::view::View
#import bevy_ui::ui_vertex_output::UiVertexOutput

@group(0) @binding(0)
var<uniform> view: View;

struct GlassMaterial {
    tint: vec4<f32>,
    highlight: vec4<f32>,
    border: vec4<f32>,
    // x: outline width px, y: vignette on, z: vignette inner radius, w: vignette strength
    params: vec4<f32>,
}

@group(1) @binding(0)
var<uniform> material: GlassMaterial;

// Signed distance to a rounded box centred on the origin; negative inside.
fn sd_rounded_box(p: vec2<f32>, half_size: vec2<f32>, radius: f32) -> f32 {
    let r = min(radius, min(half_size.x, half_size.y));
    let q = abs(p) - half_size + vec2<f32>(r);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// Same curve as `vignette_alpha` in vignette.rs, so the two cannot disagree.
fn vignette_alpha(uv: vec2<f32>, inner_radius: f32, strength: f32) -> f32 {
    let d = (uv - vec2<f32>(0.5)) * 2.0;
    let radius = length(d) / sqrt(2.0);
    let inner = clamp(inner_radius, 0.0, 0.999);
    if radius <= inner {
        return 0.0;
    }
    let t = clamp((radius - inner) / (1.0 - inner), 0.0, 1.0);
    return (t * t * (3.0 - 2.0 * t)) * clamp(strength, 0.0, 1.0);
}

@fragment
fn fragment(in: UiVertexOutput) -> @location(0) vec4<f32> {
    let p = (in.uv - vec2<f32>(0.5)) * in.size;
    let d = sd_rounded_box(p, in.size * 0.5, in.border_radius.x);
    let coverage = 1.0 - smoothstep(-1.0, 0.0, d);
    if coverage <= 0.0 {
        discard;
    }

    var rgb = material.tint.rgb;

    // A light sheen fading out over the top third reads as a glass edge catching light.
    let sheen = (1.0 - smoothstep(0.0, 0.35, in.uv.y)) * material.highlight.a;
    rgb = mix(rgb, material.highlight.rgb, sheen);

    // Outline: a band `params.x` pixels wide just inside the edge.
    let width = max(material.params.x, 0.0);
    let ring = smoothstep(-width - 1.0, -width, d) * material.border.a;
    rgb = mix(rgb, material.border.rgb, ring);

    if material.params.y > 0.5 {
        let screen_uv = (in.position.xy - view.viewport.xy) / view.viewport.zw;
        rgb = rgb * (1.0 - vignette_alpha(screen_uv, material.params.z, material.params.w));
    }

    let alpha = max(material.tint.a, ring) * coverage;
    return vec4<f32>(rgb, alpha);
}
