use bevy::prelude::*;
use bevy::render::render_resource::{Buffer, BufferInitDescriptor, BufferUsages};

use crate::game::traffic::Vehicle;
use crate::game::transport::{LaneGraph, LaneOccupancy};

/// Instance data for vehicle rendering.
#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct VehicleInstance {
    /// Position (x, y)
    pub position: [f32; 2],
    /// Rotation (radians)
    pub rotation: f32,
    /// Color (RGBA)
    pub color: [f32; 4],
    /// Scale
    pub scale: f32,
    /// Padding for alignment
    _padding: [f32; 3],
}

/// Component for vehicle instance buffer.
#[derive(Component)]
pub struct VehicleInstanceBuffer {
    pub buffer: Buffer,
    pub instance_count: u32,
}

/// System to update vehicle instance buffer.
pub fn update_vehicle_instance_buffer(
    mut commands: Commands,
    q_vehicles: Query<(Entity, &Vehicle), Without<super::Parked>>,
    lane_graph: Res<LaneGraph>,
    mut instance_buffer: Option<ResMut<VehicleInstanceBuffer>>,
    mut render_device: ResMut<bevy::render::renderer::RenderDevice>,
) {
    // Collect all vehicle instances
    let mut instances = Vec::new();

    for (_entity, vehicle) in q_vehicles.iter() {
        let position = if vehicle.lane_id != crate::game::transport::LaneId::INVALID {
            // Use lane-based position
            lane_graph.lane_s_to_tile_pos(vehicle.lane_id, vehicle.lane_s)
                .unwrap_or(vehicle.tile_pos)
        } else {
            // Fallback to tile-based position
            vehicle.tile_pos
        };

        // Convert tile position to world coordinates
        let world_pos = Vec2::new(
            position.x as f32 * 1.0, // tile_size = 1.0 for simplicity
            position.y as f32 * 1.0,
        );

        let instance = VehicleInstance {
            position: [world_pos.x, world_pos.y],
            rotation: 0.0, // TODO: calculate based on lane direction
            color: [0.8, 0.2, 0.2, 1.0], // Red cars for now
            scale: 0.8,
            _padding: [0.0; 3],
        };

        instances.push(instance);
    }

    if instances.is_empty() {
        return;
    }

    // Create or update buffer
    let buffer_data = bytemuck::cast_slice(&instances);

    if let Some(mut buffer_res) = instance_buffer {
        // Update existing buffer if size changed
        if buffer_res.instance_count != instances.len() as u32 {
            buffer_res.buffer = render_device.create_buffer(&BufferInitDescriptor {
                label: Some("vehicle_instance_buffer"),
                contents: buffer_data,
                usage: BufferUsages::VERTEX | BufferUsages::COPY_DST,
            });
            buffer_res.instance_count = instances.len() as u32;
        } else {
            // TODO: Update buffer contents
        }
    } else {
        // Create new buffer
        let buffer = render_device.create_buffer(&BufferInitDescriptor {
            label: Some("vehicle_instance_buffer"),
            contents: buffer_data,
            usage: BufferUsages::VERTEX | BufferUsages::COPY_DST,
        });

        commands.insert_resource(VehicleInstanceBuffer {
            buffer,
            instance_count: instances.len() as u32,
        });
    }
}

/// Plugin for vehicle instance rendering.
pub struct VehicleRenderPlugin;

impl Plugin for VehicleRenderPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, update_vehicle_instance_buffer);
    }
}
