use super::*;

pub(super) fn announce_main_menu() {
    info!("Main menu");
    info!("Controls:");
    info!("  Enter  - start / continue");
    info!("  Esc    - back to menu");
}

pub(super) fn announce_ingame() {
    info!("In game");
    info!("Controls:");
    info!("  WASD / Arrows - pan camera");
    info!("  Mouse wheel   - zoom");
    info!("  1 Road (cycle 2/4/6 lanes), 2 Residential, 3 Commercial, 4 Industrial, 5 Erase");
    info!("  LMB on tile   - build");
    info!("  Space         - pause");
    info!("  Esc           - back to menu");
}

pub(super) fn announce_paused() {
    info!("Paused (Space to resume)");
}
