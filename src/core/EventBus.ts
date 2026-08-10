import type { ItemHitEvent, ItemType } from './Types';
import type * as THREE from 'three';

/**
 * Strongly-typed pub/sub. This is how subsystems talk without importing
 * each other. Add new events here — never `emit('some-string')` ad hoc.
 */
export interface GameEvents {
  // Race flow
  'race:countdown': { count: number };
  'race:start': { rocketStart: boolean };
  'race:lap': { kartId: number; lap: number; lapTime: number; isBest: boolean };
  'race:finish': { kartId: number; position: number; totalTime: number };
  'race:complete': { results: Array<{ kartId: number; position: number; time: number }> };
  'race:positionChange': { kartId: number; from: number; to: number };

  // Kart
  'kart:hop': { kartId: number; position: THREE.Vector3 };
  'kart:land': { kartId: number; position: THREE.Vector3; impact: number };
  'kart:driftStart': { kartId: number; direction: number };
  'kart:driftTier': { kartId: number; tier: number; position: THREE.Vector3 };
  'kart:driftRelease': { kartId: number; tier: number; boostTime: number };
  'kart:boost': { kartId: number; duration: number; source: 'drift' | 'item' | 'pad' | 'start' | 'trick' };
  'kart:trick': { kartId: number; name: string };
  'kart:spinout': { kartId: number; position: THREE.Vector3 };
  'kart:squash': { kartId: number };
  'kart:respawn': { kartId: number };
  'kart:wallHit': { kartId: number; position: THREE.Vector3; impact: number; normal: THREE.Vector3 };
  'kart:kartHit': { a: number; b: number; impact: number; position: THREE.Vector3 };
  'kart:surfaceChange': { kartId: number; from: number; to: number };

  // Items
  'item:box': { kartId: number; position: THREE.Vector3 };
  'item:granted': { kartId: number; item: ItemType; count: number };
  'item:used': { kartId: number; item: ItemType };
  'item:hit': ItemHitEvent;
  'item:expired': { id: number };

  // Presentation
  'camera:shake': { amount: number; seconds: number };
  'camera:mode': { mode: string };
  'ui:message': { text: string; seconds: number; style?: string };
  'quality:change': { tier: string };
  'engine:ready': Record<string, never>;
  'engine:progress': { loaded: number; total: number; message: string };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(event: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(fn as Handler<never>);
    return () => this.off(event, fn);
  }

  once<K extends keyof GameEvents>(event: K, fn: Handler<GameEvents[K]>): () => void {
    const off = this.on(event, (p) => { off(); fn(p); });
    return off;
  }

  off<K extends keyof GameEvents>(event: K, fn: Handler<GameEvents[K]>): void {
    this.handlers.get(event)?.delete(fn as Handler<never>);
  }

  emit<K extends keyof GameEvents>(event: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as Handler<GameEvents[K]>)(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${String(event)}" threw:`, err);
      }
    }
  }

  clear(): void { this.handlers.clear(); }
}

/** Process-wide bus. */
export const bus = new EventBus();
