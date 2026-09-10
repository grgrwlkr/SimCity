"""Split a Tracy CSV export into the three frame-cost sources of the goals document (section 8).

Zone names may contain commas (generic system names), so each row is split from the right: the
last nine fields are src_file, src_line, total_ns, total_perc, counts, mean_ns, min_ns, max_ns,
std_ns.

Only system-level zones are summed for wall time. `par_for_each` zones are the same work spread
over worker threads and nested inside their system's zone; they are reported apart as worker CPU
time, never added to the wall figure.
"""

import sys
from collections import defaultdict

path = sys.argv[1]
by_name = defaultdict(lambda: [0, 0])
with open(path) as handle:
    next(handle)
    for line in handle:
        parts = line.rstrip("\n").rsplit(",", 9)
        if len(parts) != 10:
            continue
        try:
            total_ns = int(parts[3])
            counts = int(parts[5])
        except ValueError:
            continue
        by_name[parts[0]][0] += total_ns
        by_name[parts[0]][1] += counts


def total(name):
    return by_name.get(name, [0, 0])


RENDER = 'system{name="bevy_render::run_render_schedule"}'
FIXED = 'system{name="bevy_time::fixed::run_fixed_main_schedule"}'
app_frames = total("update")[1]


def ms(ns):
    return ns / 1e6 / app_frames


def pick(predicate):
    rows = [(name, ns, calls) for name, (ns, calls) in by_name.items() if predicate(name)]
    return sorted(rows, key=lambda row: -row[1])


def show(title, rows):
    ns = sum(row[1] for row in rows)
    print(f"\n{title}: {ms(ns):.3f} ms per app frame ({len(rows)} zones)")
    for name, zone_ns, calls in rows:
        if ms(zone_ns) >= 0.005:
            print(f"    {ms(zone_ns):7.3f}  {calls:6d}  {name[:110]}")
    return ns


print(f"app frames {app_frames}; every figure is per app frame over the whole trace")
print(f"  whole app update       {ms(total('update')[0]):.3f}")
print(f"  main app               {ms(total('main app')[0]):.3f}")
print(f"  render thread schedule {ms(total(RENDER)[0]):.3f}")

fixed_ns = total(FIXED)[0]
update_sim_ns = show(
    "SIMULATION systems on Update (outside the fixed step)",
    pick(lambda n: n.startswith('system{name="simcity_sim::')
         and abs(by_name[n][1] - app_frames) <= 5 and "debug" not in n),
)
snapshot_ns = show(
    "DEV SNAPSHOT systems",
    pick(lambda n: n.startswith('system{name="simcity_debug::game::debug_world::update_debug_')),
)
moving_systems = [
    "bevy_camera::visibility::check_visibility_cpu_culling",
    "bevy_camera::visibility::visibility_propagate_system",
    "bevy_camera::visibility::calculate_bounds",
    "bevy_transform::systems::mark_dirty_trees",
    "bevy_transform::systems::sync_simple_transforms",
    "bevy_transform::systems::parallel::propagate_parent_transforms",
    "simcity_sim::game::traffic::vehicle_render::interpolate_vehicle_position",
    "simcity_sim::game::pedestrians::agents::interpolate_pedestrian_position",
]
moving_ns = show(
    "MOVING ENTITIES, main-thread systems",
    pick(lambda n: any(n == f'system{{name="{key}"}}' for key in moving_systems)),
)
worker_ns = show(
    "MOVING ENTITIES, worker-thread par_for_each (CPU time, nested in the systems above)",
    pick(lambda n: n.startswith("par_for_each") and any(
        key in n for key in ["ViewVisibility", "InheritedVisibility", "Aabb", "GlobalTransform"])),
)
extract_ns = total("schedule{name=ExtractSchedule}")[0]
show(
    "EXTRACTION systems (nested in ExtractSchedule, shown for the breakdown only)",
    pick(lambda n: n.startswith("system{") and "extract" in n.lower() and by_name[n][1] > 1),
)

print("\nSUMMARY, main-thread wall time per app frame")
print(f"  simulation       {ms(fixed_ns + update_sim_ns):.3f}  (fixed step {ms(fixed_ns):.3f} + Update {ms(update_sim_ns):.3f})")
print(f"  dev snapshots    {ms(snapshot_ns):.3f}")
print(f"  moving entities  {ms(moving_ns + extract_ns):.3f}  (visibility and transforms {ms(moving_ns):.3f} + ExtractSchedule {ms(extract_ns):.3f})")
print(f"  plus worker CPU  {ms(worker_ns):.3f}  on moving-entity visibility queries")
