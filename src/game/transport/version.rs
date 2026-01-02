use bevy::prelude::*;

#[derive(Resource, Debug, Default, Copy, Clone)]
pub struct GraphVersion(pub u64);

impl GraphVersion {
    pub fn bump(&mut self) {
        self.0 = self.0.wrapping_add(1);
        if self.0 == 0 {
            // Avoid 0 as "special" value in cache keys after wrap.
            self.0 = 1;
        }
    }
}
