// What the feed calls an emergency of each kind. A leaf: emergencies.ts and services/vehicles.ts both read it, and
// neither has to import the other for it.
import type { EmergencyKind } from './emergencies';

export const EMERGENCY_NAMES: Readonly<Record<EmergencyKind, string>> = { Fire: 'Пожар', Crime: 'Преступление', Medical: 'Вызов скорой' };
