import * as THREE from 'three';
import { Track } from '@/track/Track';
import { QUALITY_PRESETS } from '@/core/Config';
import { SurfaceType } from '@/core/Types';
import { fakeRenderer } from '@/dev/node-run.mjs';

const scene = new THREE.Scene();
const track = new Track(scene, fakeRenderer() as unknown as THREE.WebGLRenderer, QUALITY_PRESETS.medium);
await track.loadTrack('coastal');
console.log('loaded', track.trackName, track.lapLength.toFixed(1), 'm');
const s = track.sampleAtDistance(10);
console.log('sample', s.position.toArray().map((n: number)=>n.toFixed(2)).join(','), 'surf', SurfaceType[track.surfaceAt(s.position)]);
