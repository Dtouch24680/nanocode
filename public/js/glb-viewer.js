/**
 * GLB viewer — minimal three.js setup for previewing .glb files in
 * the file explorer.
 *
 * Render modes:
 *   material   — full PBR with textures + base colors (the default)
 *   color      — base color only, all texture maps dropped
 *   clay       — neutral grey, fully rough, non-metallic
 *   wireframe  — wireframe overlay of geometry
 *
 * three.js is imported lazily so the ~600 KB bundle isn't paid for on
 * page load. The bare specifiers `three` and `three/addons/...`
 * resolve through the import map in index.html to /vendor/three/.
 *
 * Usage:
 *   const viewer = await createGlbViewer(containerEl)
 *   await viewer.load(url)
 *   viewer.setMode('clay')
 *   viewer.dispose()
 */

let threePromise = null
function loadThree() {
  if (!threePromise) {
    threePromise = Promise.all([
      import('three'),
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/controls/OrbitControls.js'),
      import('three/addons/environments/RoomEnvironment.js'),
    ]).then(([THREE, gltf, orbit, room]) => ({
      THREE,
      GLTFLoader: gltf.GLTFLoader,
      OrbitControls: orbit.OrbitControls,
      RoomEnvironment: room.RoomEnvironment,
    }))
  }
  return threePromise
}

const CLAY_COLOR = 0x9e9690
const WIRE_COLOR = 0xdddddd

export async function createGlbViewer(container) {
  const { THREE, GLTFLoader, OrbitControls, RoomEnvironment } = await loadThree()

  // --- Scene / camera / renderer ---------------------------------

  const scene = new THREE.Scene()
  // Background reads the theme — dark mode gets a near-black canvas,
  // light mode gets the warm-sand. Re-evaluated on theme change below.
  function bgForTheme() {
    return document.documentElement.dataset.theme === 'dark'
      ? new THREE.Color(0x1a1714)
      : new THREE.Color(0xf3ece2)
  }
  scene.background = bgForTheme()

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000)
  camera.position.set(2, 1.5, 3)

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  container.appendChild(renderer.domElement)

  // Indoor environment for PBR reflections — same trick three-viewer uses.
  // PMREMGenerator builds a pre-filtered cubemap from the procedural
  // RoomEnvironment scene; cheap (~5 ms one-time) and gives clay /
  // material modes their nice shading falloff without needing a HDR.
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

  // Direct key + fill so the silhouette stays readable even without
  // environment-driven specular.
  const key = new THREE.DirectionalLight(0xffffff, 1.4)
  key.position.set(3, 5, 4)
  scene.add(key)
  const fill = new THREE.AmbientLight(0xffffff, 0.35)
  scene.add(fill)

  // --- Controls --------------------------------------------------

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.1
  controls.target.set(0, 0, 0)

  // --- Render loop -----------------------------------------------

  function resize() {
    const w = container.clientWidth
    const h = container.clientHeight
    if (w === 0 || h === 0) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  const ro = new ResizeObserver(resize)
  ro.observe(container)
  resize()

  let disposed = false
  function tick() {
    if (disposed) return
    controls.update()
    renderer.render(scene, camera)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  // --- Theme watcher ---------------------------------------------

  const onThemeChange = () => { scene.background = bgForTheme() }
  document.addEventListener('nanocode:theme', onThemeChange)

  // --- Model state -----------------------------------------------

  /** @type {THREE.Object3D | null} */
  let modelRoot = null
  /** Mesh-keyed cache: { original, color, clay, wireframe }. */
  const matVariants = new WeakMap()
  let currentMode = 'material'

  // Shared single-instance materials for clay + wireframe so we save
  // GPU state changes when many meshes use them.
  const clayMaterial = new THREE.MeshStandardMaterial({
    color: CLAY_COLOR, roughness: 1.0, metalness: 0.0,
  })
  const wireMaterial = new THREE.MeshBasicMaterial({
    color: WIRE_COLOR, wireframe: true,
  })

  /** Clone an original material with every texture map dropped. */
  function buildColorVariant(original) {
    const c = original.clone()
    // Anything that uses a sampler — kill it so we render pure color.
    const mapFields = [
      'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
      'emissiveMap', 'bumpMap', 'displacementMap', 'alphaMap',
      'specularMap', 'envMap', 'clearcoatMap', 'clearcoatNormalMap',
      'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
      'transmissionMap', 'thicknessMap',
    ]
    for (const k of mapFields) if (k in c) c[k] = null
    // The base-color factor stays as the material's color.
    c.needsUpdate = true
    return c
  }

  function applyMode(mesh, mode) {
    const cache = matVariants.get(mesh)
    if (!cache) return
    if (mode === 'material')      mesh.material = cache.original
    else if (mode === 'color')    mesh.material = cache.color
    else if (mode === 'clay')     mesh.material = clayMaterial
    else if (mode === 'wireframe') mesh.material = wireMaterial
  }

  function setMode(mode) {
    if (!['material', 'color', 'clay', 'wireframe'].includes(mode)) return
    currentMode = mode
    if (!modelRoot) return
    modelRoot.traverse((obj) => {
      if (obj.isMesh) applyMode(obj, mode)
    })
  }

  // --- Load ------------------------------------------------------

  async function load(url) {
    clearModel()
    const loader = new GLTFLoader()
    const gltf = await new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject)
    })
    modelRoot = gltf.scene
    // Cache each mesh's per-mode material once on load; switching
    // afterwards is just a pointer swap.
    modelRoot.traverse((obj) => {
      if (!obj.isMesh) return
      const original = obj.material
      // GLTFLoader sometimes hands you an array (multi-material mesh).
      // Treat that case as opaque single-material for our purposes —
      // we just keep its first material as the "original".
      const m = Array.isArray(original) ? original[0] : original
      matVariants.set(obj, {
        original: m,
        color: buildColorVariant(m),
      })
    })
    scene.add(modelRoot)
    frameToObject(modelRoot)
    setMode(currentMode)
  }

  function frameToObject(obj) {
    // Compute the bounding box AFTER world matrices are up to date.
    obj.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(obj)
    if (!isFinite(box.min.x) || !isFinite(box.max.x)) return
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1
    // Position camera at ~2.5× radius along (1, 0.6, 1) direction.
    const dir = new THREE.Vector3(1, 0.6, 1).normalize()
    camera.position.copy(center).addScaledVector(dir, radius * 2.5)
    camera.near = Math.max(0.001, radius * 0.01)
    camera.far = radius * 100
    camera.updateProjectionMatrix()
    controls.target.copy(center)
    controls.update()
  }

  function clearModel() {
    if (!modelRoot) return
    scene.remove(modelRoot)
    modelRoot.traverse((obj) => {
      if (obj.isMesh) {
        const cache = matVariants.get(obj)
        if (cache?.color) cache.color.dispose()
        if (obj.geometry) obj.geometry.dispose()
      }
    })
    modelRoot = null
  }

  // --- Teardown --------------------------------------------------

  function dispose() {
    if (disposed) return
    disposed = true
    document.removeEventListener('nanocode:theme', onThemeChange)
    ro.disconnect()
    controls.dispose()
    clearModel()
    clayMaterial.dispose()
    wireMaterial.dispose()
    pmrem.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
    renderer.domElement.remove()
  }

  return { load, setMode, dispose }
}
