//! Stable IDs used by persistence.
//!
//! Bevy `Entity` is not stable across runs and must not be used as a persisted identifier.

use bevy::prelude::*;

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct CitizenId(pub u64);

#[derive(Component, Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct CitizenIdComp(pub CitizenId);

#[derive(Resource, Debug, Clone)]
pub struct CitizenIdGen {
    next: u64,
}

impl Default for CitizenIdGen {
    fn default() -> Self {
        Self { next: 1 }
    }
}

impl CitizenIdGen {
    pub fn alloc(&mut self) -> CitizenId {
        let id = CitizenId(self.next.max(1));
        self.next = self.next.saturating_add(1);
        id
    }

    pub fn next(&self) -> u64 {
        self.next
    }
}
