import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// Screen-space ribbon meshes retain their width on GPUs with one-pixel GL lines.
const STRANDS = 7, STEPS = 56, MAX_PARTICLES = 3000;
function sample(e, u, strand, time) {
  const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], len = Math.hypot(dx, dy) || 1, v = 1 - u;
  const spread = e.bend + (strand - 3) * 8 + Math.sin(time * .65 + strand * 1.7) * 10;
  const wave = Math.sin(u * Math.PI * 3 + strand * 1.4 + time * .7) * Math.sin(u * Math.PI) * 5;
  const offset = 3 * v * v * u * spread - 3 * v * u * u * spread * .65 + wave;
  return [e.a[0] + dx * u - dy / len * offset, e.a[1] + dy * u + dx / len * offset];
}

export function createFlow(fallbackCanvas, onLost) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true'); canvas.style.pointerEvents = 'none';
  let renderer, composer;
  try {
    const options = { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' };
    const context = canvas.getContext('webgl2', options);
    if (!context) throw new Error('WebGL2 unavailable; using Canvas 2D');
    renderer = new THREE.WebGLRenderer({ canvas, context, ...options });
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(0, 1364, 0, 540, -10, 10);
    camera.position.z = 1;
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1364, 540), 1.3, .65, .3);
    // The stock truncated Gaussian still has ~60% weight at its edge, making
    // isolated sparks bloom into boxes. Let each separable kernel decay first.
    for (const material of bloom.separableBlurMaterials) {
      const weights = material.uniforms.gaussianCoefficients.value;
      const sigma = weights.length / 4;
      for (let i = 0; i < weights.length; i++) weights[i] = Math.exp(-.5 * i * i / (sigma * sigma));
    }
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    // UnrealBloomPass writes opaque alpha. Rebuild coverage from the final,
    // tone-mapped light, with premultiplied RGB for native page compositing.
    // Black becomes fully transparent; even the faint bloom retains soft edges.
    composer.addPass(new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: `varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
        void main() { vec3 light = texture2D(tDiffuse, vUv).rgb;
          float coverage = clamp(max(light.r, max(light.g, light.b)), 0., 1.);
          gl_FragColor = vec4(light, coverage); }`
    }));
    fallbackCanvas.after(canvas);
    const ribbons = new THREE.Group(); scene.add(ribbons);
    const lineMaterial = new THREE.MeshBasicMaterial({ color: 0xff3d8b, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    // Explicit billboard UVs avoid driver-dependent point-sprite coordinates.
    const particleGeometry = new THREE.InstancedBufferGeometry();
    particleGeometry.setAttribute('position', new THREE.Float32BufferAttribute([-.5,-.5,0, .5,-.5,0, .5,.5,0, -.5,.5,0], 3));
    particleGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    const positions = new Float32Array(MAX_PARTICLES * 3), sizes = new Float32Array(MAX_PARTICLES), intensities = new Float32Array(MAX_PARTICLES), whites = new Float32Array(MAX_PARTICLES);
    for (const [name, array, size] of [['offset', positions, 3], ['size', sizes, 1], ['intensity', intensities, 1], ['white', whites, 1]]) particleGeometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage));
    const particleMaterial = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: `attribute vec3 offset; attribute float size; attribute float intensity; attribute float white;
        varying float power; varying float pale; varying vec2 spriteUv;
        void main() { power = intensity; pale = white; spriteUv = position.xy * 2.;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(offset + position * size, 1.); }`,
      fragmentShader: `varying float power; varying float pale; varying vec2 spriteUv;
        void main() { float r = length(spriteUv); if (r >= 1.) discard;
          float halo = exp(-r*r*5.) * (1. - smoothstep(.55, 1., r));
          float core = exp(-r*r*36.);
          vec3 pink = mix(vec3(1., .045, .26), vec3(1., .55, .72), pale);
          gl_FragColor = vec4((pink * halo * .65 + vec3(1.8) * core) * power, halo); }`
    });
    const particles = new THREE.Mesh(particleGeometry, particleMaterial); particles.frustumCulled = false; scene.add(particles);
    let dpr = 1, count = 0, budget = 1800, slow = 0, dimensions = '';
    function particle(x, y, size, intensity, white = 0) {
      if (count >= MAX_PARTICLES) return;
      positions[count * 3] = x; positions[count * 3 + 1] = y; sizes[count] = size; intensities[count] = intensity; whites[count] = white; count++;
    }
    function dispose() {
      for (const mesh of [...ribbons.children]) { mesh.geometry.dispose(); mesh.material.dispose(); ribbons.remove(mesh); }
      particleGeometry.dispose(); particleMaterial.dispose(); lineMaterial.dispose(); composer.dispose(); renderer.dispose(); canvas.remove();
    }
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); dispose(); onLost(); }, { once: true });
    return {
      resize(width, height, ratio) {
        const displayWidth = canvas.parentElement.getBoundingClientRect().width || width;
        const key = `${width}:${height}:${ratio}:${displayWidth}`;
        if (dimensions === key) return;
        dimensions = key;
        dpr = Math.min(2, ratio); renderer.setPixelRatio(dpr); renderer.setSize(width, height, false);
        composer.setPixelRatio(dpr); composer.setSize(width, height);
        camera.right = width; camera.bottom = height; camera.updateProjectionMatrix();
        budget = displayWidth < 700 || navigator.hardwareConcurrency <= 4 ? 900 : 2400;
      },
      draw(edges, hub, visible, time) {
        const start = performance.now(); count = 0;
        const needed = edges.length * STRANDS;
        while (ribbons.children.length > needed) { const mesh = ribbons.children.at(-1); ribbons.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
        while (ribbons.children.length < needed) {
          const geometry = new THREE.BufferGeometry(), vertices = new Float32Array(STEPS * 6 * 3);
          geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3).setUsage(THREE.DynamicDrawUsage));
          const mesh = new THREE.Mesh(geometry, lineMaterial.clone()); mesh.frustumCulled = false; ribbons.add(mesh);
        }
        edges.forEach((e, index) => {
          const waiting = e.status === 'waiting', active = e.active;
          const power = active ? (waiting ? .85 + Math.sin(time * 2.4) * .2 : 1.1) : .19;
          for (let j = 0; j < STRANDS; j++) {
            const mesh = ribbons.children[index * STRANDS + j], array = mesh.geometry.attributes.position.array;
            mesh.material.color.setRGB(power * 1.25, power * (waiting ? .8 : .07), power * (waiting ? 1 : .35));
            const width = active ? 1.6 : .8;
            let prev = sample(e, 0, j, time);
            for (let k = 0; k < STEPS; k++) {
              const next = sample(e, (k + 1) / STEPS, j, time), dx = next[0] - prev[0], dy = next[1] - prev[1], len = Math.hypot(dx, dy) || 1;
              const nx = -dy / len * width / 2, ny = dx / len * width / 2;
              array.set([prev[0]+nx,prev[1]+ny,0, prev[0]-nx,prev[1]-ny,0, next[0]+nx,next[1]+ny,0, next[0]+nx,next[1]+ny,0, prev[0]-nx,prev[1]-ny,0, next[0]-nx,next[1]-ny,0], k * 18);
              prev = next;
            }
            mesh.geometry.attributes.position.needsUpdate = true;
            const density = Math.max(1, Math.min(active ? 8 : 2, Math.floor((budget - 90) / Math.max(1, needed))));
            for (let p = 0; p < density; p++) {
              const phase = (time * (waiting ? .12 : active ? .22 : .035) + p / density + j * .137 + index * .173) % 1;
              const xy = sample(e, e.returning ? 1 - phase : phase, j, time);
              particle(...xy, p % 5 ? 8 : 13, active ? 1.65 : .5, waiting ? 1 : .15);
            }
          }
          // Large soft dock flashes, with a hot white nucleus at the card border.
          for (const xy of [e.a, e.b]) {
            particle(...xy, active ? 54 : 25, power * .9, waiting ? 1 : 0);
            particle(...xy, active ? 20 + Math.sin(time * 3 + index) * 3 : 9, power * 3.8, .5);
          }
        });
        if (visible) {
          particle(...hub, 380, .22, 0);
          for (let i = 0; i < 70; i++) {
            const a = i * 2.399 + time * .025, r = 117 + Math.sin(i * 7 + time * .4) * 4;
            particle(hub[0] + Math.cos(a) * r, hub[1] + Math.sin(a) * r, i % 7 ? 9 : 18, i % 7 ? .65 : 1.2);
          }
        }
        particleGeometry.instanceCount = count;
        for (const attribute of Object.values(particleGeometry.attributes)) if (attribute.isInstancedBufferAttribute) attribute.needsUpdate = true;
        composer.render();
        // Reduce density on sustained slow frames, not on a single shader compilation.
        if (performance.now() - start > 28) { if (++slow > 25) { budget = Math.max(350, budget * .8); slow = 0; } } else slow = Math.max(0, slow - 1);
      },
      dispose
    };
  } catch (error) { composer?.dispose(); renderer?.dispose(); canvas.remove(); throw error; }
}
