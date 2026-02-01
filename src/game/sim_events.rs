use bevy::prelude::*;

#[derive(Message, Debug, Copy, Clone)]
pub struct DayAdvanced {
    pub day: u32,
}

#[derive(Message, Debug, Copy, Clone)]
pub struct HourAdvanced {
    pub hour: u8,
    pub day: u32,
}
