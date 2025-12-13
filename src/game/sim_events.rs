use bevy::prelude::*;

#[derive(Message, Debug, Copy, Clone)]
pub struct DayAdvanced {
    pub day: u32,
}
