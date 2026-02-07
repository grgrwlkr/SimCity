/// Unique identifier for vehicles in the lane occupancy system.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct VehicleId(pub u32);

impl VehicleId {
    /// Invalid vehicle ID constant.
    pub const INVALID: VehicleId = VehicleId(u32::MAX);
}
