use bevy::prelude::*;

#[derive(Message, Debug, Copy, Clone)]
pub struct DayAdvanced {
    pub day: u32,
}

#[derive(Message, Debug, Copy, Clone)]
pub struct HourAdvanced {
    #[allow(dead_code)] // Carried for debugging/telemetry
    pub hour: u8,
    #[allow(dead_code)] // Carried for debugging/telemetry
    pub day: u32,
}
