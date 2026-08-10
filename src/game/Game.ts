import * as THREE from 'three';
import { Engine } from '@/core/Engine';
import { Input } from '@/core/Input';
import { bus } from '@/core/EventBus';
import type { FrameContext, ISubsystem, QualityTier } from '@/core/Types';

import { RenderPipeline } from '@/render/RenderPipeline';
import { Lighting } from '@/world/Lighting';
import { Sky } from '@/world/Sky';
import { Environment } from '@/world/Environment';
import { Track } from '@/track/Track';
import { KartManager } from '@/karts/KartManager';
import { PhysicsWorld } from '@/physics/PhysicsWorld';
import { ChaseCamera } from '@/camera/ChaseCamera';
import { VfxManager } from '@/vfx/VfxManager';
import { ItemSystem } from '@/items/ItemSystem';
import { AIManager } from '@/ai/AIManager';
import { AudioEngine } from '@/audio/AudioEngine';
import { HUD } from '@/ui/HUD';
import { MenuSystem } from '@/ui/MenuSystem';
import { RaceDirector } from '@/game/RaceDirector';

/**
 * Call an optional setter on a subsystem if it implements one.
 *
 * Subsystems are authored independently, so a given build may or may not
 * declare a particular late-wiring hook. Missing hooks are not an error —
 * that subsystem simply doesn't need the dependency.
 */
function wire<T>(target: unknown, method: string, dep: T): void {
  const fn = (target as Record<string, unknown> | undefined)?.[method];
  if (typeof fn === 'function') {
    try {
      (fn as (d: T) => void).call(target, dep);
    } catch (err) {
      console.error(`[Game] ${method} failed:`, err);
    }
  }
}

/**
 * Game is the composition root. It builds every subsystem, hands each one the
 * (few) dependencies it is allowed to see, and registers them with Engine in
 * the correct update order.
 *
 * UPDATE ORDER MATTERS:
 *   fixedUpdate: physics -> ai -> items -> race
 *   update:      karts(visual) -> vfx -> camera -> audio -> ui -> render
 */
export class Game {
  readonly engine: Engine;
  readonly input: Input;

  track!: Track;
  karts!: KartManager;
  physics!: PhysicsWorld;
  camera!: ChaseCamera;
  vfx!: VfxManager;
  items!: ItemSystem;
  ai!: AIManager;
  audio!: AudioEngine;
  hud!: HUD;
  menus!: MenuSystem;
  race!: RaceDirector;
  pipeline!: RenderPipeline;
  lighting!: Lighting;
  sky!: Sky;
  environment!: Environment;

  private container: HTMLElement;

  constructor(container: HTMLElement, tier: QualityTier = 'ultra') {
    this.container = container;
    this.engine = new Engine(container, tier);
    this.input = new Input(this.engine.canvas);
  }

  private progress(loaded: number, total: number, message: string) {
    bus.emit('engine:progress', { loaded, total, message });
  }

  async init(): Promise<void> {
    const { engine } = this;
    const scene = engine.scene;
    const steps = 14;
    let n = 0;

    this.input.init();
    this.progress(++n, steps, 'Input');

    // --- world lighting & sky ------------------------------------------------
    this.sky = new Sky(scene, engine.renderer);
    await this.sky.init();
    this.progress(++n, steps, 'Sky');

    this.lighting = new Lighting(scene, engine.renderer, engine.camera, engine.quality);
    await this.lighting.init();
    this.progress(++n, steps, 'Lighting');

    // --- track ---------------------------------------------------------------
    this.track = new Track(scene, engine.renderer, engine.quality);
    await this.track.init();
    this.progress(++n, steps, 'Track');

    this.environment = new Environment(scene, engine.renderer, this.track, engine.quality);
    await this.environment.init();
    this.progress(++n, steps, 'Environment');

    // --- physics + karts -----------------------------------------------------
    this.physics = new PhysicsWorld(this.track);
    await this.physics.init?.();
    this.progress(++n, steps, 'Physics');

    this.karts = new KartManager(scene, engine.renderer, this.track, this.physics, engine.quality);
    await this.karts.init();
    this.progress(++n, steps, 'Karts');

    this.physics.setKarts(this.karts.karts);

    // --- presentation --------------------------------------------------------
    this.vfx = new VfxManager(scene, engine.renderer, engine.camera, this.karts, engine.quality);
    await this.vfx.init();
    this.progress(++n, steps, 'Effects');

    this.camera = new ChaseCamera(engine.camera, this.karts, this.track, this.input.state);
    await this.camera.init?.();
    this.progress(++n, steps, 'Camera');

    // --- gameplay systems ----------------------------------------------------
    this.items = new ItemSystem(scene, this.track, this.karts, this.physics, this.vfx);
    await this.items.init();
    this.progress(++n, steps, 'Items');

    this.ai = new AIManager(this.track, this.karts, this.items);
    await this.ai.init?.();
    this.progress(++n, steps, 'Opponents');

    this.audio = new AudioEngine(engine.camera);
    await this.audio.init();
    this.progress(++n, steps, 'Audio');

    this.race = new RaceDirector(this.karts, this.track, this.input.state);
    await this.race.init?.();
    this.progress(++n, steps, 'Race');

    // --- late cross-wiring ---------------------------------------------------
    // Subsystems built in parallel declare optional setters for dependencies
    // that don't exist yet at their construction time. Wire them here, guarded,
    // so a missing setter is never fatal.
    wire(this.ai, 'setPhysics', this.physics);
    wire(this.ai, 'setItems', this.items);
    wire(this.race, 'setPhysics', this.physics);
    wire(this.race, 'setItems', this.items);
    wire(this.race, 'setAudio', this.audio);
    wire(this.race, 'setVfx', this.vfx);
    wire(this.camera, 'setVfx', this.vfx);
    wire(this.camera, 'setRace', this.race);
    wire(this.karts, 'setVfx', this.vfx);
    wire(this.karts, 'setAudio', this.audio);
    wire(this.items, 'setAudio', this.audio);
    wire(this.lighting, 'setSky', this.sky);

    // --- UI + post -----------------------------------------------------------
    this.hud = new HUD(this.container, this.karts, this.race, this.track, engine);
    await this.hud.init();

    this.menus = new MenuSystem(this.container, this);

    this.pipeline = new RenderPipeline(engine, this.karts, this.track);
    await this.pipeline.init();
    engine.setRenderCallback((dt) => this.pipeline.render(dt));
    wire(this.vfx, 'setPipeline', this.pipeline);
    wire(this.hud, 'setAudio', this.audio);
    wire(this.menus, 'setAudio', this.audio);
    this.progress(++n, steps, 'Ready');

    // --- register in strict order -------------------------------------------
    const ordered: ISubsystem[] = [
      // --- simulation ---
      this.input,
      this.physics,
      this.ai,
      this.items,
      this.race,
      // --- visual transforms: karts pose from physics, then the camera frames them ---
      this.karts,
      // The camera MUST run before anything that reads the camera in update().
      // It previously sat after `lighting`, so shadow cascades were fitted to
      // the PREVIOUS frame's frustum, and vfx billboarding + the audio listener
      // were a frame stale too.
      this.camera,
      // --- world dressing & lighting, all camera-dependent ---
      this.track,
      this.environment,
      this.sky,
      this.lighting,
      this.vfx,
      this.audio,
      // --- presentation ---
      this.hud,
      this.menus,
      this.pipeline,
      // Input edge-flag consumer must be dead last.
      { update: () => this.input.endFrame() },
    ];
    for (const s of ordered) engine.add(s);

    await engine.initAll();
    bus.emit('engine:ready', {});
  }

  start(): void {
    this.engine.start();
    this.menus?.showMainMenu();
  }

  /** Begin a race from the menu. */
  startRace(opts: { trackId?: string; characterId?: string; cc?: number } = {}): void {
    this.race.beginRace(opts);
  }

  dispose(): void { this.engine.dispose(); }
}
