import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { ConcreteSceneTheme } from './types'

const BUILDING_URLS = [
  '/models/ultraman/city/building-skyscraper-a.glb',
  '/models/ultraman/city/building-skyscraper-b.glb',
  '/models/ultraman/city/building-skyscraper-c.glb',
  '/models/ultraman/city/building-skyscraper-d.glb',
  '/models/ultraman/city/building-g.glb',
]

// ---- 确定性伪随机（确保每个场景构图稳定美观） ----
function seededRandom(seed: number) {
  let s = seed % 2147483647
  if (s <= 0) s += 2147483646
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

// ---- 程序化 Canvas PBR 贴图生成器 ----
function makeAsphaltRoadTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 512
  const ctx = c.getContext('2d')!

  // 柏油颗粒底色
  ctx.fillStyle = '#383d47'
  ctx.fillRect(0, 0, 512, 512)
  const rng = seededRandom(101)
  for (let i = 0; i < 4500; i++) {
    const g = Math.floor(42 + rng() * 32)
    ctx.fillStyle = `rgb(${g},${g + 3},${g + 8})`
    ctx.fillRect(rng() * 512, rng() * 512, 2, 2)
  }

  // 两侧水泥人行道与路缘石
  ctx.fillStyle = '#9ca3af'
  ctx.fillRect(0, 0, 56, 512)
  ctx.fillRect(456, 0, 56, 512)
  ctx.fillStyle = '#cbd5e1'
  for (let y = 0; y < 512; y += 32) {
    ctx.fillRect(52, y, 8, 28)
    ctx.fillRect(452, y, 8, 28)
  }

  // 白色车道边线
  ctx.fillStyle = '#e5e7eb'
  ctx.fillRect(72, 0, 7, 512)
  ctx.fillRect(433, 0, 7, 512)

  // 中央双黄虚实线
  ctx.fillStyle = '#facc15'
  for (let y = 12; y < 512; y += 64) {
    ctx.fillRect(247, y, 7, 38)
    ctx.fillRect(258, y, 7, 38)
  }

  // 白色斑马线（前景交叉口质感）
  ctx.fillStyle = 'rgba(241,245,249,0.85)'
  for (let x = 94; x < 420; x += 34) {
    ctx.fillRect(x, 220, 18, 54)
  }

  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(1, 3.2)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeContainerTexture(hex: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 128
  const ctx = c.getContext('2d')!
  ctx.fillStyle = hex
  ctx.fillRect(0, 0, 256, 128)

  // 金属瓦楞竖向凹凸条纹
  for (let x = 8; x < 248; x += 12) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)'
    ctx.fillRect(x, 8, 4, 112)
    ctx.fillStyle = 'rgba(255,255,255,0.16)'
    ctx.fillRect(x + 4, 8, 3, 112)
  }
  // 钢边框
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'
  ctx.lineWidth = 8
  ctx.strokeRect(4, 4, 248, 120)
  // 白色货运编号铭牌
  ctx.fillStyle = 'rgba(255,255,255,0.88)'
  ctx.fillRect(178, 22, 54, 18)
  ctx.fillStyle = '#1e293b'
  ctx.fillRect(184, 27, 42, 4)
  ctx.fillRect(184, 33, 28, 3)

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeSandTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#e8cf97'
  ctx.fillRect(0, 0, 256, 256)
  const rng = seededRandom(202)
  for (let i = 0; i < 3000; i++) {
    ctx.fillStyle = rng() > 0.5 ? 'rgba(255,248,225,0.35)' : 'rgba(180,145,86,0.25)'
    ctx.fillRect(rng() * 256, rng() * 256, 3, 2)
  }
  // 柔波沙纹
  ctx.strokeStyle = 'rgba(196,162,102,0.28)'
  ctx.lineWidth = 3
  for (let y = 16; y < 256; y += 28) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.bezierCurveTo(85, y - 6, 170, y + 6, 256, y)
    ctx.stroke()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(8, 8)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeMountainGroundTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 512
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#4e7438'
  ctx.fillRect(0, 0, 512, 512)

  // 中央碎石峡谷泥土战道
  const grad = ctx.createLinearGradient(140, 0, 372, 0)
  grad.addColorStop(0, 'rgba(116,98,74,0)')
  grad.addColorStop(0.2, '#826f55')
  grad.addColorStop(0.5, '#968366')
  grad.addColorStop(0.8, '#826f55')
  grad.addColorStop(1, 'rgba(116,98,74,0)')
  ctx.fillStyle = grad
  ctx.fillRect(140, 0, 232, 512)

  const rng = seededRandom(303)
  for (let i = 0; i < 5000; i++) {
    const x = rng() * 512
    const y = rng() * 512
    ctx.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.12)' : 'rgba(25,35,18,0.2)'
    ctx.fillRect(x, y, 3, 3)
  }

  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(1, 2.5)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeVolcanoGroundTextures(): { map: THREE.CanvasTexture; emissiveMap: THREE.CanvasTexture } {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 512
  const ctx = c.getContext('2d')!

  const ec = document.createElement('canvas')
  ec.width = 512
  ec.height = 512
  const ectx = ec.getContext('2d')!

  ctx.fillStyle = '#252129'
  ctx.fillRect(0, 0, 512, 512)
  ectx.fillStyle = '#000000'
  ectx.fillRect(0, 0, 512, 512)

  const rng = seededRandom(404)
  // 火山灰岩石噪点
  for (let i = 0; i < 4000; i++) {
    const v = Math.floor(24 + rng() * 34)
    ctx.fillStyle = `rgb(${v + 4},${v},${v + 6})`
    ctx.fillRect(rng() * 512, rng() * 512, 3, 3)
  }

  // 龟裂熔岩火纹
  for (let i = 0; i < 22; i++) {
    let x = rng() * 512
    let y = rng() * 512
    ctx.strokeStyle = '#ff5a1f'
    ctx.lineWidth = 2.5
    ectx.strokeStyle = '#ff6a00'
    ectx.lineWidth = 3.5
    ctx.beginPath()
    ectx.beginPath()
    ctx.moveTo(x, y)
    ectx.moveTo(x, y)
    for (let s = 0; s < 5; s++) {
      x += (rng() - 0.5) * 90
      y += (rng() - 0.5) * 90
      ctx.lineTo(x, y)
      ectx.lineTo(x, y)
    }
    ctx.stroke()
    ectx.stroke()
  }

  const map = new THREE.CanvasTexture(c)
  map.wrapS = map.wrapT = THREE.RepeatWrapping
  map.repeat.set(4, 4)
  map.colorSpace = THREE.SRGBColorSpace

  const emissiveMap = new THREE.CanvasTexture(ec)
  emissiveMap.wrapS = emissiveMap.wrapT = THREE.RepeatWrapping
  emissiveMap.repeat.set(4, 4)
  emissiveMap.colorSpace = THREE.SRGBColorSpace

  return { map, emissiveMap }
}

/**
 * 多主题高细节 3D 战场管理器
 * 支持：阳光海边(seaside)、繁华都市(city)、翠绿山区(mountain)、火山遗迹(volcano)
 */
export class ArenaManager {
  public readonly root = new THREE.Group()
  private readonly scene: THREE.Scene
  private themeGroup = new THREE.Group()
  private currentTheme: ConcreteSceneTheme = 'seaside'

  private cityTemplates: THREE.Group[] = []
  private texturesToDispose: THREE.Texture[] = []

  // 动态更新引用
  private seaUniforms: { uTime: { value: number } } | null = null
  private clouds: THREE.Group[] = []
  private palmCrowns: THREE.Object3D[] = []
  private embers: Array<{ mesh: THREE.Mesh; speed: number; baseX: number; baseZ: number; phase: number }> = []
  private waterfallMat: THREE.MeshBasicMaterial | null = null
  private lavaGlowMats: THREE.MeshStandardMaterial[] = []
  private shipGroup: THREE.Group | null = null

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.root.name = 'ArenaRoot'
    this.root.add(this.themeGroup)
    scene.add(this.root)
    this.buildTheme('seaside')
  }

  public getTheme(): ConcreteSceneTheme {
    return this.currentTheme
  }

  /** 加载 Kenney CC0 城市大楼资产模板（加载完毕后若当前处于都市/海边则自动刷新建筑层） */
  public async loadCityBuildings(loader: GLTFLoader): Promise<void> {
    if (this.cityTemplates.length > 0) return
    const loaded = await Promise.all(
      BUILDING_URLS.map(async (url) => {
        try {
          const gltf = await loader.loadAsync(url)
          return gltf.scene
        } catch {
          return null
        }
      }),
    )
    this.cityTemplates = loaded.filter((t): t is THREE.Group => t !== null)
    if (this.currentTheme === 'city' || this.currentTheme === 'seaside') {
      this.buildTheme(this.currentTheme)
    }
  }

  /** 实时切换战场主题（释放旧场景显存资源，重建新场景） */
  public setTheme(theme: ConcreteSceneTheme) {
    if (this.currentTheme === theme && this.themeGroup.children.length > 0) return
    this.buildTheme(theme)
  }

  private clearTheme() {
    this.root.remove(this.themeGroup)
    this.themeGroup.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const mesh = node as THREE.Mesh
        // 避免误释放被 clone 引用的共享 cityTemplates 几何
        if (!mesh.userData.sharedTemplate) {
          mesh.geometry.dispose()
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const m of mats) m.dispose()
        }
      }
    })
    for (const tex of this.texturesToDispose) tex.dispose()
    this.texturesToDispose = []
    this.clouds = []
    this.palmCrowns = []
    this.embers = []
    this.seaUniforms = null
    this.waterfallMat = null
    this.lavaGlowMats = []
    this.shipGroup = null

    this.themeGroup = new THREE.Group()
    this.themeGroup.name = `Theme_${this.currentTheme}`
    this.root.add(this.themeGroup)
  }

  private buildTheme(theme: ConcreteSceneTheme) {
    this.currentTheme = theme
    this.clearTheme()

    if (theme === 'seaside') this.buildSeasideArena()
    else if (theme === 'city') this.buildCityArena()
    else if (theme === 'mountain') this.buildMountainArena()
    else this.buildVolcanoArena()
  }

  // ---- 通用天空穹顶与三点电影灯光 ----
  private addSkyAndLights(opts: {
    bgHex: number
    fogHex: number
    fogDensity: number
    topColor: number
    midColor: number
    horizonColor: number
    sunColor: number
    sunDir: [number, number, number]
    sunIntensity: number
    hemiSky: number
    hemiGround: number
    hemiIntensity: number
    rimColor: number
    rimIntensity: number
  }) {
    this.scene.background = new THREE.Color(opts.bgHex)
    this.scene.fog = new THREE.FogExp2(opts.fogHex, opts.fogDensity)

    const skyGeo = new THREE.SphereGeometry(310, 28, 18)
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(opts.topColor) },
        midColor: { value: new THREE.Color(opts.midColor) },
        horizonColor: { value: new THREE.Color(opts.horizonColor) },
        sunGlow: { value: new THREE.Color(opts.sunColor) },
        sunDir: { value: new THREE.Vector3(...opts.sunDir).normalize() },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vDir = normalize(wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 horizonColor;
        uniform vec3 sunGlow;
        uniform vec3 sunDir;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 col = mix(horizonColor, midColor, smoothstep(0.0, 0.28, h));
          col = mix(col, topColor, smoothstep(0.24, 0.85, h));
          float sunDot = max(dot(vDir, sunDir), 0.0);
          col += sunGlow * pow(sunDot, 12.0) * 0.45;
          col += vec3(1.0, 0.98, 0.9) * smoothstep(0.996, 0.9995, sunDot) * 0.9;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
    this.themeGroup.add(new THREE.Mesh(skyGeo, skyMat))

    const hemi = new THREE.HemisphereLight(opts.hemiSky, opts.hemiGround, opts.hemiIntensity)
    this.themeGroup.add(hemi)

    const sun = new THREE.DirectionalLight(opts.sunColor, opts.sunIntensity)
    sun.position.set(opts.sunDir[0] * 70, opts.sunDir[1] * 70, opts.sunDir[2] * 70)
    sun.castShadow = true
    sun.shadow.mapSize.set(1024, 1024)
    sun.shadow.camera.near = 10
    sun.shadow.camera.far = 180
    sun.shadow.camera.left = -50
    sun.shadow.camera.right = 50
    sun.shadow.camera.top = 50
    sun.shadow.camera.bottom = -50
    sun.shadow.bias = -0.0006
    this.themeGroup.add(sun)

    const rim = new THREE.DirectionalLight(opts.rimColor, opts.rimIntensity)
    rim.position.set(-32, 24, -36)
    this.themeGroup.add(rim)
  }

  private addClouds(colorHex: number, opacity: number, defs: Array<[number, number, number, number]>) {
    const mat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity })
    for (const [cx, cy, cz, scale] of defs) {
      const g = new THREE.Group()
      g.position.set(cx, cy, cz)
      g.scale.setScalar(scale)
      const puffs: Array<[number, number, number, number]> = [
        [0, 0, 0, 8],
        [-7, -1, 1, 5.8],
        [7.2, -0.8, -0.5, 6.2],
        [2.2, 2.6, 0.5, 5.4],
        [-2.8, 2.0, -0.8, 4.8],
      ]
      for (const [x, y, z, r] of puffs) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat)
        m.position.set(x, y, z)
        m.scale.set(1.45, 0.62, 0.9)
        g.add(m)
      }
      this.themeGroup.add(g)
      this.clouds.push(g)
    }
  }

  private placeCityBuilding(x: number, z: number, scale: number, rotY: number, tplIdx: number) {
    if (this.cityTemplates.length === 0) return
    const tpl = this.cityTemplates[tplIdx % this.cityTemplates.length]!
    const clone = tpl.clone(true)
    clone.scale.setScalar(scale)
    clone.position.set(x, 0, z)
    clone.rotation.y = rotY
    clone.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const mesh = node as THREE.Mesh
        mesh.userData.sharedTemplate = true
        mesh.receiveShadow = true
      }
    })
    this.themeGroup.add(clone)
  }

  // =========================================================================
  // 场景 1：阳光海边 / 港口湾（动态波光大海 + 沙滩椰林 + 灯塔 + 瓦楞集装箱 + 货轮跨海大桥）
  // =========================================================================
  private buildSeasideArena() {
    this.addSkyAndLights({
      bgHex: 0x62bcf7,
      fogHex: 0xa7defc,
      fogDensity: 0.0028,
      topColor: 0x1565c0,
      midColor: 0x5ab8f5,
      horizonColor: 0xd6f1ff,
      sunColor: 0xfff4d9,
      sunDir: [0.55, 0.58, -0.6],
      sunIntensity: 2.25,
      hemiSky: 0xdcf2ff,
      hemiGround: 0x8b7e66,
      hemiIntensity: 1.15,
      rimColor: 0x9be2ff,
      rimIntensity: 0.95,
    })

    // 1. 海岸码头广场 + 细腻公路
    const roadTex = makeAsphaltRoadTexture()
    this.texturesToDispose.push(roadTex)
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 96),
      new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.92 }),
    )
    road.rotation.x = -Math.PI / 2
    road.position.set(0, 0.04, 4)
    road.receiveShadow = true
    this.themeGroup.add(road)

    // 左侧金色细腻沙滩（带坡度入海）
    const sandTex = makeSandTexture()
    this.texturesToDispose.push(sandTex)
    const beach = new THREE.Mesh(
      new THREE.PlaneGeometry(110, 120),
      new THREE.MeshStandardMaterial({ map: sandTex, roughness: 0.95 }),
    )
    beach.rotation.x = -Math.PI / 2
    beach.position.set(-64, -0.02, 2)
    beach.receiveShadow = true
    this.themeGroup.add(beach)

    // 右侧港口水泥装卸码头
    const dock = new THREE.Mesh(
      new THREE.PlaneGeometry(110, 115),
      new THREE.MeshStandardMaterial({ color: 0x88919e, roughness: 0.88 }),
    )
    dock.rotation.x = -Math.PI / 2
    dock.position.set(64, -0.01, 4)
    dock.receiveShadow = true
    this.themeGroup.add(dock)

    // 防波堤石坎 + 护栏柱
    const seawall = new THREE.Mesh(
      new THREE.BoxGeometry(220, 2.2, 3.6),
      new THREE.MeshStandardMaterial({ color: 0xb0b8c4, roughness: 0.85 }),
    )
    seawall.position.set(0, 0.4, -46)
    seawall.receiveShadow = true
    this.themeGroup.add(seawall)

    // 2. 自定义 GLSL Shader 动态海浪海面（拍岸浪花 + 阳光波光反射！）
    this.seaUniforms = { uTime: { value: 0 } }
    const seaGeo = new THREE.PlaneGeometry(480, 240, 72, 48)
    const seaMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.seaUniforms.uTime,
        uDeep: { value: new THREE.Color(0x0b5ea8) },
        uShallow: { value: new THREE.Color(0x18b4d8) },
        uFoam: { value: new THREE.Color(0xeefaff) },
      },
      vertexShader: `
        uniform float uTime;
        varying vec2 vUv;
        varying float vWave;
        void main() {
          vUv = uv;
          vec3 p = position;
          float w = sin(p.x * 0.08 + uTime * 2.1) * 0.35 + cos(p.y * 0.12 - uTime * 1.6) * 0.28;
          p.z += w;
          vWave = w;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uDeep;
        uniform vec3 uShallow;
        uniform vec3 uFoam;
        varying vec2 vUv;
        varying float vWave;
        void main() {
          // vUv.y 靠近 0 为远海，靠近 1 为岸边
          float shore = smoothstep(0.65, 1.0, vUv.y);
          vec3 col = mix(uDeep, uShallow, shore);
          float sparkle = smoothstep(0.42, 0.62, vWave + sin(vUv.x * 90.0 + uTime * 3.0) * 0.12);
          col = mix(col, uFoam, sparkle * 0.32);
          float surfLine = smoothstep(0.92, 0.99, vUv.y + sin(vUv.x * 40.0 + uTime * 2.4) * 0.025);
          col = mix(col, uFoam, surfLine * 0.85);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
    const sea = new THREE.Mesh(seaGeo, seaMat)
    sea.rotation.x = -Math.PI / 2
    sea.position.set(0, -0.7, -166)
    this.themeGroup.add(sea)

    // 3. 左侧沙滩椰子树林 + 经典红白条纹海滨灯塔
    const palmCoords: Array<[number, number, number]> = [
      [-18, 12, 1.05],
      [-23, 2, 0.95],
      [-20, -10, 1.15],
      [-27, -20, 1.0],
      [-19, -32, 0.92],
      [-32, -8, 1.2],
      [-36, 8, 1.1],
      [-30, -35, 1.12],
      [-42, -22, 1.05],
      [-24, 24, 1.0],
    ]
    for (const [px, pz, sc] of palmCoords) {
      this.addPalmTree(px, pz, sc)
    }
    this.addLighthouse(-38, -42)

    // 4. 右侧精细瓦楞纹港口集装箱堆场 + 桁架式龙门吊
    const containerColors = ['#dc2626', '#2563eb', '#d97706', '#059669', '#0284c7', '#e11d48']
    const containerMats = containerColors.map((hex) => {
      const t = makeContainerTexture(hex)
      this.texturesToDispose.push(t)
      return new THREE.MeshStandardMaterial({ map: t, roughness: 0.52, metalness: 0.32 })
    })
    const boxGeo = new THREE.BoxGeometry(6.4, 2.7, 2.6)
    const stacks: Array<[number, number, number, number]> = [
      [18, -14, 2, 0],
      [25, -16, 3, 1],
      [20, -24, 2, 2],
      [28, -26, 3, 3],
      [19, -34, 2, 4],
      [27, -36, 2, 5],
      [21, 6, 2, 1],
      [29, 2, 3, 0],
      [36, -12, 3, 2],
    ]
    stacks.forEach(([x, z, layers, colIdx], idx) => {
      for (let l = 0; l < layers; l++) {
        const m = new THREE.Mesh(boxGeo, containerMats[(colIdx + l + idx) % containerMats.length]!)
        m.position.set(x, 1.35 + l * 2.74, z)
        m.castShadow = true
        m.receiveShadow = true
        this.themeGroup.add(m)
      }
    })
    this.addTrussCrane(28, -42, -0.14, 0xea580c)
    this.addTrussCrane(46, -42, -0.05, 0xf59e0b)

    // 5. 海面巨型集装箱货轮 + 远方红色跨海斜拉大桥 + 青翠海湾群岛
    this.shipGroup = this.createCargoShip(containerMats)
    this.shipGroup.position.set(38, -0.4, -92)
    this.shipGroup.rotation.y = -0.35
    this.themeGroup.add(this.shipGroup)

    this.addBaySuspensionBridge(-20, -125)
    this.addSeaIslands()

    // 6. 两侧外围海滨城市大楼
    const coastBuildings: Array<[number, number, number, number, number]> = [
      [48, 16, 7.2, -Math.PI / 2, 0],
      [52, -4, 8.6, -Math.PI / 2, 1],
      [54, -24, 7.8, -Math.PI / 2, 2],
      [-52, 16, 6.8, Math.PI / 2, 3],
      [-58, -10, 8.2, Math.PI / 2, 4],
    ]
    for (const [x, z, s, ry, idx] of coastBuildings) {
      this.placeCityBuilding(x, z, s, ry, idx)
    }

    this.addClouds(0xffffff, 0.85, [
      [-75, 55, -115, 1.5],
      [-12, 62, -140, 1.9],
      [58, 56, -125, 1.6],
      [115, 48, -100, 1.3],
    ])
  }

  private addPalmTree(x: number, z: number, scale: number) {
    const g = new THREE.Group()
    g.position.set(x, 0, z)
    g.scale.setScalar(scale)

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.9 })
    // 4 节微弯树干
    let curX = 0
    let curY = 0
    for (let i = 0; i < 4; i++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.32 - i * 0.04, 0.38 - i * 0.04, 2.2, 7), trunkMat)
      const tilt = 0.08 + i * 0.06
      seg.position.set(curX + Math.sin(tilt) * 0.9, curY + 1.0, 0)
      seg.rotation.z = -tilt
      seg.castShadow = true
      g.add(seg)
      curX += Math.sin(tilt) * 1.9
      curY += 1.95
    }

    const crown = new THREE.Group()
    crown.position.set(curX, curY + 0.2, 0)
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x228b22, roughness: 0.72, side: THREE.DoubleSide })
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2
      const frond = new THREE.Mesh(new THREE.ConeGeometry(1.1, 4.6, 5), leafMat)
      frond.scale.set(0.35, 1, 0.85)
      frond.position.set(Math.cos(a) * 1.9, -0.35, Math.sin(a) * 1.9)
      frond.rotation.y = -a
      frond.rotation.z = -1.15
      crown.add(frond)
    }
    g.add(crown)
    this.palmCrowns.push(crown)
    this.themeGroup.add(g)
  }

  private addLighthouse(x: number, z: number) {
    const g = new THREE.Group()
    g.position.set(x, 0, z)
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.55 })
    const redMat = new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.55 })

    // 5 层红白条纹塔身
    for (let i = 0; i < 5; i++) {
      const rBot = 2.6 - i * 0.26
      const rTop = 2.34 - i * 0.26
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, 3.6, 14), i % 2 === 0 ? whiteMat : redMat)
      seg.position.y = 1.8 + i * 3.6
      seg.castShadow = true
      g.add(seg)
    }
    // 观景平台 + 发光灯室 + 红屋顶
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 1.9, 0.6, 14), redMat)
    deck.position.y = 18.2
    g.add(deck)
    const lamp = new THREE.Mesh(
      new THREE.CylinderGeometry(1.25, 1.25, 2.2, 12),
      new THREE.MeshBasicMaterial({ color: 0xfef08a }),
    )
    lamp.position.y = 19.6
    g.add(lamp)
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.8, 2.4, 12), redMat)
    roof.position.y = 21.8
    g.add(roof)

    this.themeGroup.add(g)
  }

  private addTrussCrane(x: number, z: number, rotY: number, colorHex: number) {
    const crane = new THREE.Group()
    crane.position.set(x, 0, z)
    crane.rotation.y = rotY
    const mat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.48, metalness: 0.42 })
    const cableMat = new THREE.MeshBasicMaterial({ color: 0x334155 })

    // 门架四腿 + 斜撑
    const legGeo = new THREE.BoxGeometry(1.0, 24, 1.0)
    const coords: Array<[number, number]> = [
      [-4.2, -3.2],
      [4.2, -3.2],
      [-4.2, 3.2],
      [4.2, 3.2],
    ]
    for (const [lx, lz] of coords) {
      const leg = new THREE.Mesh(legGeo, mat)
      leg.position.set(lx, 12, lz)
      crane.add(leg)
    }
    // 顶部梯形塔冠
    const apex = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 3.8, 8, 4), mat)
    apex.position.set(0, 27.5, 0)
    apex.rotation.y = Math.PI / 4
    crane.add(apex)

    // 长吊臂与斜拉钢索
    const boom = new THREE.Mesh(new THREE.BoxGeometry(28, 1.4, 2.2), mat)
    boom.position.set(-2, 22, 0)
    crane.add(boom)
    for (const bx of [-14, 10]) {
      const len = Math.hypot(bx, 9.5)
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, len, 6), cableMat)
      cable.position.set(bx * 0.5, 26.8, 0)
      cable.rotation.z = Math.atan2(bx, 9.5)
      crane.add(cable)
    }
    // 驾驶室
    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 2.4, 2.8),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 }),
    )
    cab.position.set(-6, 19.6, 0)
    crane.add(cab)
    this.themeGroup.add(crane)
  }

  private createCargoShip(containerMats: THREE.Material[]): THREE.Group {
    const ship = new THREE.Group()
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x991b1b, roughness: 0.65 })
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 })
    const bridgeMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.45 })

    const hull = new THREE.Mesh(new THREE.BoxGeometry(46, 5.5, 13), hullMat)
    hull.position.y = 2.2
    ship.add(hull)
    const upperHull = new THREE.Mesh(new THREE.BoxGeometry(48, 2.5, 13.4), deckMat)
    upperHull.position.y = 5.8
    ship.add(upperHull)
    // 船尾白色舰桥
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(7, 11, 11), bridgeMat)
    bridge.position.set(16, 11.5, 0)
    ship.add(bridge)
    // 船上彩色集装箱
    const cGeo = new THREE.BoxGeometry(6.5, 2.8, 3.0)
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 3; col++) {
        for (let h = 0; h < 2; h++) {
          const box = new THREE.Mesh(cGeo, containerMats[(row + col + h) % containerMats.length]!)
          box.position.set(-15 + row * 7.2, 8.4 + h * 2.9, -3.4 + col * 3.4)
          ship.add(box)
        }
      }
    }
    return ship
  }

  private addBaySuspensionBridge(centerX: number, z: number) {
    const g = new THREE.Group()
    g.position.set(centerX, 0, z)
    const redMat = new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.5, metalness: 0.35 })
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.8 })
    const cableMat = new THREE.MeshBasicMaterial({ color: 0xe2e8f0 })

    // 桥面
    const deck = new THREE.Mesh(new THREE.BoxGeometry(220, 2.2, 7), deckMat)
    deck.position.y = 14
    g.add(deck)
    // 两座红色巨型桥塔
    for (const tx of [-46, 46]) {
      for (const tz of [-3.2, 3.2]) {
        const pylon = new THREE.Mesh(new THREE.BoxGeometry(2.8, 44, 2.8), redMat)
        pylon.position.set(tx, 22, tz)
        g.add(pylon)
      }
      const cross = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 8), redMat)
      cross.position.set(tx, 34, 0)
      g.add(cross)
      // 斜拉索
      for (const offset of [-32, -20, -10, 10, 20, 32]) {
        const len = Math.hypot(offset, 24)
        const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, len, 5), cableMat)
        cable.position.set(tx + offset * 0.5, 26, 0)
        cable.rotation.z = Math.atan2(offset, 24)
        g.add(cable)
      }
    }
    this.themeGroup.add(g)
  }

  private addSeaIslands() {
    const islandMat = new THREE.MeshStandardMaterial({ color: 0x4b8f68, roughness: 0.92 })
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x679ec9, roughness: 0.95 })
    const defs: Array<[number, number, number, number, boolean]> = [
      [-105, -175, 56, 30, false],
      [-35, -195, 62, 38, false],
      [48, -188, 52, 26, false],
      [112, -165, 58, 34, true],
    ]
    for (const [x, z, r, h, green] of defs) {
      const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 9), green ? islandMat : rockMat)
      m.position.set(x, h * 0.45 - 2, z)
      m.scale.set(1.3, 1, 0.85)
      this.themeGroup.add(m)
    }
  }

  // =========================================================================
  // 场景 2：繁华都市（特摄金色夕阳 + 精细柏油斑马线大道 + 多层高楼 + 路灯轿车行道树 + 电视塔）
  // =========================================================================
  private buildCityArena() {
    this.addSkyAndLights({
      bgHex: 0xd98a5b,
      fogHex: 0xeba97b,
      fogDensity: 0.0034,
      topColor: 0x1e3a6d,
      midColor: 0xc26d5c,
      horizonColor: 0xffc785,
      sunColor: 0xffd28e,
      sunDir: [0.35, 0.26, -0.9],
      sunIntensity: 2.35,
      hemiSky: 0xffe2be,
      hemiGround: 0x4b5563,
      hemiIntensity: 1.05,
      rimColor: 0x7dd3fc,
      rimIntensity: 1.0,
    })

    // 1. 宽阔城市柏油大地 + 斑马线主干道
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(260, 260),
      new THREE.MeshStandardMaterial({ color: 0x565d68, roughness: 0.92 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.themeGroup.add(ground)

    const roadTex = makeAsphaltRoadTexture()
    this.texturesToDispose.push(roadTex)
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 140),
      new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.9 }),
    )
    road.rotation.x = -Math.PI / 2
    road.position.set(0, 0.04, -10)
    road.receiveShadow = true
    this.themeGroup.add(road)

    // 2. 三层纵深高密度摩天大楼街区（Kenney CC0 + 玻璃幕墙塔楼 + 屋顶发光霓虹招牌）
    const cityLayout: Array<[number, number, number, number, number]> = [
      // 近景临街左右大楼
      [-24, 24, 6.2, Math.PI / 2, 0],
      [-26, 8, 7.6, Math.PI / 2, 1],
      [-27, -10, 8.4, Math.PI / 2, 2],
      [-28, -28, 7.8, Math.PI / 2, 3],
      [-26, -46, 8.8, Math.PI / 2, 4],
      [24, 24, 6.4, -Math.PI / 2, 1],
      [26, 6, 8.0, -Math.PI / 2, 0],
      [27, -12, 8.6, -Math.PI / 2, 3],
      [28, -30, 7.6, -Math.PI / 2, 2],
      [26, -48, 9.2, -Math.PI / 2, 4],
      // 中景二排摩天楼
      [-46, 14, 10.5, 0, 2],
      [-48, -14, 11.8, 0, 0],
      [-46, -42, 11.0, 0, 1],
      [46, 12, 10.2, 0, 3],
      [48, -16, 12.2, 0, 1],
      [46, -44, 11.4, 0, 0],
      // 远景宽阔天际线
      [-68, -74, 14.0, 0, 0],
      [-42, -82, 15.2, 0, 2],
      [-18, -94, 13.5, 0, 1],
      [20, -92, 14.5, 0, 3],
      [44, -80, 15.0, 0, 0],
      [70, -72, 13.8, 0, 4],
    ]
    for (const [x, z, s, ry, idx] of cityLayout) {
      this.placeCityBuilding(x, z, s, ry, idx)
    }

    // 补充玻璃幕墙现代塔楼与屋顶霓虹广告牌（即使大楼模型还在加载时也画面饱满）
    const neonColors = [0x38bdf8, 0xfacc15, 0xf43f5e, 0x34d399]
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x334e68,
      roughness: 0.25,
      metalness: 0.65,
    })
    const extraTowers: Array<[number, number, number, number, number]> = [
      [-36, -64, 12, 38, 12],
      [36, -64, 13, 42, 12],
      [-58, -30, 14, 34, 14],
      [58, -30, 14, 36, 14],
    ]
    extraTowers.forEach(([x, z, w, h, d], idx) => {
      const tower = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), glassMat)
      tower.position.set(x, h / 2, z)
      this.themeGroup.add(tower)
      const sign = new THREE.Mesh(
        new THREE.BoxGeometry(w * 0.72, 2.2, 0.8),
        new THREE.MeshBasicMaterial({ color: neonColors[idx % neonColors.length]! }),
      )
      sign.position.set(x, h + 1.4, z + d * 0.45)
      this.themeGroup.add(sign)
    })

    // 3. 远方城市标志性红白电视发射塔（致敬特摄东京铁塔！）
    this.addCityRadioTower(0, -112)

    // 4. 远景横跨公路的城市高架桥
    const overpass = new THREE.Mesh(
      new THREE.BoxGeometry(110, 2.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.8 }),
    )
    overpass.position.set(0, 11.5, -56)
    this.themeGroup.add(overpass)
    for (const px of [-24, 24]) {
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(1.4, 1.6, 11.5, 10),
        new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.85 }),
      )
      pillar.position.set(px, 5.75, -56)
      this.themeGroup.add(pillar)
    }

    // 5. 街边细节：暖光路灯 + 行道树 + 停放小轿车
    const lampPoleMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.5 })
    const lampBulbMat = new THREE.MeshBasicMaterial({ color: 0xfef08a })
    const treeTrunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.9 })
    const treeLeafMat = new THREE.MeshStandardMaterial({ color: 0x3b7a38, roughness: 0.8 })
    const carColors = [0xef4444, 0x3b82f6, 0xf8fafc, 0xf59e0b]

    for (let z = -38; z <= 28; z += 14) {
      for (const side of [-1, 1]) {
        // 路灯
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 6.2, 6), lampPoleMat)
        pole.position.set(side * 12.6, 3.1, z)
        this.themeGroup.add(pole)
        const arm = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.16, 0.16), lampPoleMat)
        arm.position.set(side * 11.8, 6.1, z)
        this.themeGroup.add(arm)
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6), lampBulbMat)
        bulb.position.set(side * 11.0, 5.95, z)
        this.themeGroup.add(bulb)

        // 行道树
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.32, 2.2, 6), treeTrunkMat)
        trunk.position.set(side * 14.5, 1.1, z + 6)
        this.themeGroup.add(trunk)
        const canopy = new THREE.Mesh(new THREE.DodecahedronGeometry(1.75, 0), treeLeafMat)
        canopy.position.set(side * 14.5, 3.2, z + 6)
        this.themeGroup.add(canopy)
      }
    }

    // 路边停放小轿车
    const carSpots: Array<[number, number, number]> = [
      [-9.2, 10, 0],
      [9.2, -4, 1],
      [-9.2, -22, 2],
      [9.2, -34, 3],
    ]
    for (const [cx, cz, ci] of carSpots) {
      const car = new THREE.Group()
      car.position.set(cx, 0, cz)
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(2.0, 0.8, 4.2),
        new THREE.MeshStandardMaterial({ color: carColors[ci]!, roughness: 0.35, metalness: 0.45 }),
      )
      body.position.y = 0.6
      const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 0.7, 2.2),
        new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.25 }),
      )
      cabin.position.set(0, 1.25, -0.2)
      car.add(body, cabin)
      this.themeGroup.add(car)
    }

    this.addClouds(0xffd4b8, 0.72, [
      [-65, 58, -110, 1.6],
      [10, 64, -135, 2.0],
      [78, 52, -118, 1.5],
    ])
  }

  private addCityRadioTower(x: number, z: number) {
    const g = new THREE.Group()
    g.position.set(x, 0, z)
    const redMat = new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.5 })
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.5 })

    // 6 层渐收红白塔身 + 观景台 + 避雷针红灯
    const layers: Array<[number, number, number, number]> = [
      [11, 7.5, 16, 8],
      [7.5, 5.2, 14, 23],
      [5.2, 3.6, 14, 37],
      [3.6, 2.2, 12, 50],
      [2.2, 1.0, 12, 62],
    ]
    layers.forEach(([rb, rt, h, y], idx) => {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(rt, rb, h, 4, 1, false),
        idx % 2 === 0 ? redMat : whiteMat,
      )
      mesh.position.y = y
      mesh.rotation.y = Math.PI / 4
      g.add(mesh)
    })
    const deck = new THREE.Mesh(new THREE.BoxGeometry(11, 3.5, 11), whiteMat)
    deck.position.y = 30
    g.add(deck)
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.5, 14, 6), whiteMat)
    spire.position.y = 75
    g.add(spire)
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2a2a }),
    )
    beacon.position.y = 82.5
    g.add(beacon)
    this.themeGroup.add(g)
  }

  // =========================================================================
  // 场景 3：翠绿山区 / 峡谷水坝（3D 起伏群山顶点着色 + 160 棵松树林 + 巨石阵 + 瀑布大坝 + 铁塔）
  // =========================================================================
  private buildMountainArena() {
    this.addSkyAndLights({
      bgHex: 0x6ec6f5,
      fogHex: 0xb7e4fa,
      fogDensity: 0.0029,
      topColor: 0x1e6bd6,
      midColor: 0x6ac2f5,
      horizonColor: 0xdff5ff,
      sunColor: 0xfff8e6,
      sunDir: [0.5, 0.68, 0.52],
      sunIntensity: 2.15,
      hemiSky: 0xd8f3ff,
      hemiGround: 0x3f6233,
      hemiIntensity: 1.2,
      rimColor: 0xbef264,
      rimIntensity: 0.65,
    })

    // 1. 翠绿草地 + 中央碎石泥土峡谷战道
    const groundTex = makeMountainGroundTexture()
    this.texturesToDispose.push(groundTex)
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 140),
      new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.96 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.set(0, 0, -10)
    ground.receiveShadow = true
    this.themeGroup.add(ground)

    // 2. 3D 连续起伏环绕群山地形（中心战场平坦 y=0，周围平滑抬升出连绵峰峦 + 顶点海拔着色）
    const terrainGeo = new THREE.PlaneGeometry(340, 320, 72, 68)
    terrainGeo.rotateX(-Math.PI / 2)
    const posAttr = terrainGeo.attributes.position!
    const colors = new Float32Array(posAttr.count * 3)
    const cGrass = new THREE.Color(0x4d7c36)
    const cForest = new THREE.Color(0x2d5a27)
    const cRock = new THREE.Color(0x746d64)
    const cSnow = new THREE.Color(0xf1f5f9)
    const tmpCol = new THREE.Color()

    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i)
      const z = posAttr.getZ(i)
      // 保留中央峡谷平地通道 (|x| < 18 且 z > -42)
      const distCenterX = Math.max(0, Math.abs(x) - 18)
      const distBackZ = Math.max(0, -z - 46)
      const valleyFactor = Math.min(1, Math.hypot(distCenterX / 24, distBackZ / 26))

      const ridge =
        Math.sin(x * 0.045) * Math.cos(z * 0.04) * 20 +
        Math.sin(x * 0.11 + z * 0.08) * 9 +
        Math.cos(x * 0.025 - z * 0.035) * 18 +
        24
      let y = Math.max(0, ridge) * Math.pow(valleyFactor, 1.35)
      if (z > 32 && Math.abs(x) < 26) y = 0 // 相机后方不挡镜头
      posAttr.setY(i, y - 0.12)

      // 按海拔与噪声混合翠绿草地 -> 深林 -> 灰褐岩石 -> 远峰积雪
      if (y < 4) tmpCol.copy(cGrass)
      else if (y < 18) tmpCol.copy(cGrass).lerp(cForest, (y - 4) / 14)
      else if (y < 36) tmpCol.copy(cForest).lerp(cRock, (y - 18) / 18)
      else tmpCol.copy(cRock).lerp(cSnow, Math.min(1, (y - 36) / 14))

      colors[i * 3] = tmpCol.r
      colors[i * 3 + 1] = tmpCol.g
      colors[i * 3 + 2] = tmpCol.b
    }
    terrainGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    terrainGeo.computeVertexNormals()
    const terrain = new THREE.Mesh(
      terrainGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, flatShading: true }),
    )
    terrain.position.set(0, 0, -25)
    terrain.receiveShadow = true
    this.themeGroup.add(terrain)

    // 3. 160 棵 InstancedMesh 三层松树林（高性能渲染漫山森林！）
    this.addPineForestInstanced(160)

    // 4. 散落巨石与山岩
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.92, flatShading: true })
    const rng = seededRandom(505)
    for (let i = 0; i < 32; i++) {
      const side = i % 2 === 0 ? -1 : 1
      const rx = side * (16 + rng() * 30)
      const rz = -42 + rng() * 68
      const r = 1.2 + rng() * 2.6
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), rockMat)
      rock.position.set(rx, r * 0.45, rz)
      rock.scale.set(1.2, 0.72, 1.0)
      rock.rotation.set(rng() * 3, rng() * 3, 0)
      rock.castShadow = true
      rock.receiveShadow = true
      this.themeGroup.add(rock)
    }

    // 5. 远方峡谷宏伟混凝土大坝 + 飞流瀑布水帘
    this.addHydroDam(0, -68)

    // 6. 山脊高压输电铁塔（极有日本特摄郊外味！）
    this.addPowerPylon(-32, -32)
    this.addPowerPylon(34, -26)

    this.addClouds(0xffffff, 0.86, [
      [-80, 62, -110, 1.6],
      [-5, 70, -145, 2.2],
      [70, 64, -125, 1.7],
    ])
  }

  private addPineForestInstanced(count: number) {
    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.42, 2.6, 6)
    const tier1Geo = new THREE.ConeGeometry(2.1, 4.2, 7)
    const tier2Geo = new THREE.ConeGeometry(1.5, 3.6, 7)
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c3a21, roughness: 0.95 })
    const leafMat1 = new THREE.MeshStandardMaterial({ color: 0x1f5c2e, roughness: 0.85, flatShading: true })
    const leafMat2 = new THREE.MeshStandardMaterial({ color: 0x2f7d32, roughness: 0.82, flatShading: true })

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count)
    const tiers1 = new THREE.InstancedMesh(tier1Geo, leafMat1, count)
    const tiers2 = new THREE.InstancedMesh(tier2Geo, leafMat2, count)
    const dummy = new THREE.Object3D()
    const rng = seededRandom(777)

    for (let i = 0; i < count; i++) {
      const side = i % 2 === 0 ? -1 : 1
      const x = side * (17 + rng() * 58)
      const z = -62 + rng() * 92
      const sc = 0.75 + rng() * 1.1
      const baseY = Math.max(0, (Math.abs(x) - 24) * 0.22)

      dummy.position.set(x, baseY + 1.3 * sc, z)
      dummy.scale.setScalar(sc)
      dummy.rotation.y = rng() * Math.PI * 2
      dummy.updateMatrix()
      trunks.setMatrixAt(i, dummy.matrix)

      dummy.position.set(x, baseY + 3.8 * sc, z)
      dummy.updateMatrix()
      tiers1.setMatrixAt(i, dummy.matrix)

      dummy.position.set(x, baseY + 6.0 * sc, z)
      dummy.updateMatrix()
      tiers2.setMatrixAt(i, dummy.matrix)
    }

    this.themeGroup.add(trunks, tiers1, tiers2)
  }

  private addHydroDam(x: number, z: number) {
    const g = new THREE.Group()
    g.position.set(x, 0, z)
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xb8bec8, roughness: 0.85 })
    const wall = new THREE.Mesh(new THREE.BoxGeometry(58, 28, 10), wallMat)
    wall.position.y = 14
    g.add(wall)

    // 坝顶桥栏
    const topDeck = new THREE.Mesh(
      new THREE.BoxGeometry(62, 2.2, 12),
      new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.8 }),
    )
    topDeck.position.y = 28.5
    g.add(topDeck)

    // 泄洪闸门暗框 + 瀑布白水帘 + 底部水雾泡沫
    const gateMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.85 })
    const foamMat = new THREE.MeshBasicMaterial({ color: 0xf0f9ff, transparent: true, opacity: 0.72 })
    this.waterfallMat = new THREE.MeshBasicMaterial({
      color: 0xe0f7ff,
      transparent: true,
      opacity: 0.84,
    })
    for (const wx of [-10, 0, 10]) {
      const gate = new THREE.Mesh(new THREE.BoxGeometry(6.4, 4.2, 0.9), gateMat)
      gate.position.set(wx, 25.2, 5.1)
      g.add(gate)
      const water = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 24), this.waterfallMat)
      water.position.set(wx, 12.2, 5.25)
      g.add(water)
      const mist = new THREE.Mesh(new THREE.SphereGeometry(3.2, 8, 6), foamMat)
      mist.scale.set(1.3, 0.55, 0.8)
      mist.position.set(wx, 1.2, 6.4)
      g.add(mist)
    }
    // 坝底水潭
    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(18, 20),
      new THREE.MeshStandardMaterial({ color: 0x22a6d8, roughness: 0.25, metalness: 0.25 }),
    )
    pool.rotation.x = -Math.PI / 2
    pool.position.set(0, 0.08, 13)
    g.add(pool)
    this.themeGroup.add(g)
  }

  private addPowerPylon(x: number, z: number) {
    const g = new THREE.Group()
    g.position.set(x, 0, z)
    const steel = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.5, metalness: 0.6 })
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 2.4, 24, 4, 1, true), steel)
    body.position.y = 12
    body.rotation.y = Math.PI / 4
    g.add(body)
    for (const ay of [15, 20]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(10, 0.7, 0.7), steel)
      arm.position.y = ay
      g.add(arm)
    }
    this.themeGroup.add(g)
  }

  // =========================================================================
  // 场景 4：火山古代遗迹（紫红风暴天幕 + 发光熔岩裂缝大地 + 远古巨石柱林 + 活火山群 + 火星余烬）
  // =========================================================================
  private buildVolcanoArena() {
    this.addSkyAndLights({
      bgHex: 0x3a162d,
      fogHex: 0x572034,
      fogDensity: 0.0034,
      topColor: 0x1d0b2b,
      midColor: 0x7a223b,
      horizonColor: 0xf26426,
      sunColor: 0xffa05c,
      sunDir: [0.35, 0.45, 0.75],
      sunIntensity: 2.35,
      hemiSky: 0xd8b4fe,
      hemiGround: 0xff7033,
      hemiIntensity: 1.25,
      rimColor: 0x5ce1ff,
      rimIntensity: 1.45,
    })

    // 1. 焦黑龟裂带炽热岩浆纹的火山大地
    const { map, emissiveMap } = makeVolcanoGroundTextures()
    this.texturesToDispose.push(map, emissiveMap)
    const groundMat = new THREE.MeshStandardMaterial({
      map,
      emissive: new THREE.Color(0xff4500),
      emissiveMap,
      emissiveIntensity: 1.4,
      roughness: 0.9,
    })
    this.lavaGlowMats.push(groundMat)
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.themeGroup.add(ground)

    // 2. 两侧奔流发光熔岩河沟
    const lavaMat = new THREE.MeshStandardMaterial({
      color: 0xff5a1f,
      emissive: 0xff4500,
      emissiveIntensity: 2.0,
      roughness: 0.3,
    })
    this.lavaGlowMats.push(lavaMat)
    for (const side of [-1, 1]) {
      const river = new THREE.Mesh(new THREE.PlaneGeometry(8, 160), lavaMat)
      river.rotation.x = -Math.PI / 2
      river.position.set(side * 20, 0.06, -20)
      this.themeGroup.add(river)
    }

    // 3. 露露耶风格古代巨石遗迹柱阵与残破拱门
    const stoneMat = new THREE.MeshStandardMaterial({
      color: 0x4a4352,
      roughness: 0.92,
      flatShading: true,
    })
    const pillars: Array<[number, number, number, number]> = [
      [-15, 10, 12, 0.05],
      [-15, -6, 15, -0.04],
      [-15, -22, 9.5, 0.14],
      [-15, -36, 14, -0.02],
      [15, 10, 11, -0.06],
      [15, -6, 15.5, 0.03],
      [15, -22, 13, -0.08],
      [15, -36, 8.5, 0.18],
    ]
    for (const [px, pz, h, tilt] of pillars) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.8, h, 8), stoneMat)
      col.position.set(px, h / 2, pz)
      col.rotation.z = tilt
      col.castShadow = true
      col.receiveShadow = true
      this.themeGroup.add(col)

      const base = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.6, 4.2), stoneMat)
      base.position.set(px, 0.8, pz)
      this.themeGroup.add(base)
    }

    // 远景巨型古代残破石门
    for (const sx of [-18, 18]) {
      const gateCol = new THREE.Mesh(new THREE.BoxGeometry(4.5, 24, 4.5), stoneMat)
      gateCol.position.set(sx, 12, -48)
      this.themeGroup.add(gateCol)
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(44, 4.2, 5.2), stoneMat)
    lintel.position.set(0, 24.5, -48)
    this.themeGroup.add(lintel)

    // 4. 远方三座喷发炽热红光的活火山群
    const volcMat = new THREE.MeshStandardMaterial({
      color: 0x261d28,
      roughness: 0.95,
      flatShading: true,
    })
    const volcanoes: Array<[number, number, number, number]> = [
      [-62, -118, 42, 52],
      [0, -135, 54, 64],
      [66, -115, 44, 48],
    ]
    for (const [vx, vz, r, h] of volcanoes) {
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.18, r, h, 10), volcMat)
      cone.position.set(vx, h / 2 - 2, vz)
      this.themeGroup.add(cone)
      const crater = new THREE.Mesh(
        new THREE.CircleGeometry(r * 0.17, 10),
        new THREE.MeshBasicMaterial({ color: 0xff6a00 }),
      )
      crater.rotation.x = -Math.PI / 2
      crater.position.set(vx, h - 1.8, vz)
      this.themeGroup.add(crater)
    }

    // 5. 空中飘升的炽热余烬火星
    const emberGeo = new THREE.SphereGeometry(0.28, 5, 5)
    const rng = seededRandom(909)
    for (let i = 0; i < 80; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? 0xff7b29 : 0xfacc15,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const mesh = new THREE.Mesh(emberGeo, mat)
      const bx = (rng() - 0.5) * 68
      const bz = -45 + rng() * 75
      mesh.position.set(bx, rng() * 34, bz)
      this.themeGroup.add(mesh)
      this.embers.push({
        mesh,
        speed: 2.2 + rng() * 4.5,
        baseX: bx,
        baseZ: bz,
        phase: rng() * Math.PI * 2,
      })
    }

    this.addClouds(0x4a2538, 0.7, [
      [-60, 56, -100, 1.8],
      [25, 62, -120, 2.2],
      [85, 52, -95, 1.6],
    ])
  }

  public update(dt: number, elapsedTime: number) {
    if (this.seaUniforms) {
      this.seaUniforms.uTime.value = elapsedTime
    }
    if (this.shipGroup) {
      this.shipGroup.position.y = -0.4 + Math.sin(elapsedTime * 1.4) * 0.35
      this.shipGroup.rotation.z = Math.sin(elapsedTime * 1.1) * 0.025
    }
    for (let i = 0; i < this.palmCrowns.length; i++) {
      this.palmCrowns[i]!.rotation.z = Math.sin(elapsedTime * 1.6 + i) * 0.055
    }
    if (this.waterfallMat) {
      this.waterfallMat.opacity = 0.72 + Math.sin(elapsedTime * 9) * 0.1
    }
    for (const mat of this.lavaGlowMats) {
      mat.emissiveIntensity = 1.35 + Math.sin(elapsedTime * 2.8) * 0.45
    }
    for (const e of this.embers) {
      e.mesh.position.y += e.speed * dt
      e.mesh.position.x = e.baseX + Math.sin(elapsedTime * 1.8 + e.phase) * 1.6
      if (e.mesh.position.y > 36) {
        e.mesh.position.y = 0.2
      }
    }
    for (const c of this.clouds) {
      c.position.x += dt * 1.2
      if (c.position.x > 175) c.position.x = -175
    }
  }
}
