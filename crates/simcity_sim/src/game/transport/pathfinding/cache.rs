use super::*;

pub fn enforce_cache_limits(time_now_sec: f64, cfg: &PathfindingConfig, cache: &mut PathCache) {
    // TTL purge (approximate, front-biased)
    while let Some((key, used)) = cache.lru.front().copied() {
        if time_now_sec - used <= cfg.cache_ttl_secs {
            break;
        }
        cache.lru.pop_front();
        if let Some(e) = cache.map.get(&key)
            && (e.last_used_sec - used).abs() < f64::EPSILON
        {
            cache.map.remove(&key);
        }
    }

    // Capacity purge (approximate LRU)
    while cache.map.len() > cfg.cache_capacity {
        let Some((key, used)) = cache.lru.pop_front() else {
            break;
        };
        if let Some(e) = cache.map.get(&key)
            && (e.last_used_sec - used).abs() < f64::EPSILON
        {
            cache.map.remove(&key);
        }
    }
}
