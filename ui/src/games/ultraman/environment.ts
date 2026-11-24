import * as THREE from 'three'
import { GroundedSkybox } from 'three/examples/jsm/objects/GroundedSkybox.js'
import type { ConcreteSceneTheme } from './types'

const ASSETS = '/models/ultraman/landscape'
const STAGES = {
  seaside: {
    heading: 0.48,
    light: 0xffeed2,
    power: 2.05,
    rim: 0x7dd3fc,
    rimPower: 1.1,
    sun: [0.8, 0.72, -0.28],
    dust: 0xbab2a6,
    fog: 0xa8c2d8,
  },
  city: {
    heading: 0.92,
    light: 0xebf2ff,
    power: 1.45,
    rim: 0x93c5fd,
    rimPower: 1.25,
    sun: [-0.55, 0.9, 0.46],
    dust: 0xa79f96,
    fog: 0x94a3b8,
  },
  mountain: {
    heading: 0.52,
    light: 0xfff2d6,
    power: 2.1,
    rim: 0xa7f3d0,
    rimPower: 0.95,
    sun: [0.53, 1, -0.68],
    dust: 0x9c8e6b,
    fog: 0xb2c5b8,
  },
  volcano: {
    heading: 0.65,
    light: 0xffb37a,
    power: 1.85,
    rim: 0xff6b35,
    rimPower: 1.65,
    sun: [-0.65, 0.48, -0.55],
    dust: 0x785c52,
    fog: 0x3b2420,
  },
} as const

/**
 * 物理级实景特摄战场管理器：
 * - PMREM 预过滤环境反射（消除粗糙表面塑料油光）
 * - 三点特摄布光（主太阳光 + 半球漫射光 + 戏剧轮廓逆光 Rim Light）
 * - 角色与怪兽实时脚底环境光遮蔽贴花（Contact AO）
 * - 火山动态升腾余烬与地面震波尘浪
 */
export class ArenaManager {
  private theme: ConcreteSceneTheme = 'seaside'
  private selected: ConcreteSceneTheme | null = null
  private ready: Promise<void> = Promise.resolve()
  private revision = 0
  private disposed = false
  private readonly root = new THREE.Group()
  private readonly sun = new THREE.DirectionalLight()
  private readonly rim = new THREE.DirectionalLight(0x7dd3fc, 1.1)
  private readonly fill = new THREE.HemisphereLight(0xe4eefc, 0x6f655c, 0.88)
  private readonly contact = new THREE.Mesh(
    new THREE.PlaneGeometry(110, 120),
    new THREE.ShadowMaterial({ opacity: 0.42, depthWrite: false }),
  )
  private readonly heroContactAO: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private readonly kaijuContactAO: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private readonly aoTexture: THREE.CanvasTexture

  private sky: GroundedSkybox | null = null
  private envRenderTarget: THREE.WebGLRenderTarget | null = null
  private readonly pmrem: THREE.PMREMGenerator
  private readonly fixtures = new THREE.Group()
  private ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | null = null
  private readonly dust = makeImpactDust()
  private readonly embers = makeVolcanoEmbers()
  private impactTime = -Infinity
  private readonly heat = { value: 0 }
  private readonly loader = new THREE.TextureLoader()

  constructor(
    private readonly scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
  ) {
    this.pmrem = new THREE.PMREMGenerator(renderer)
    this.pmrem.compileEquirectangularShader()

    this.contact.rotation.x = -Math.PI / 2
    this.contact.position.y = 0.015
    this.contact.receiveShadow = true

    this.aoTexture = makeSoftBlobTexture()
    const makeAO = (size: number, opacity: number) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({
          map: this.aoTexture,
          transparent: true,
          opacity,
          depthWrite: false,
        }),
      )
      m.rotation.x = -Math.PI / 2
      m.position.y = 0.025
      m.renderOrder = -2
      return m
    }
    this.heroContactAO = makeAO(9.5, 0.52)
    this.kaijuContactAO = makeAO(13.5, 0.58)

    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    Object.assign(this.sun.shadow.camera, {
      left: -28,
      right: 28,
      top: 28,
      bottom: -28,
      near: 1,
      far: 150,
    })
    this.sun.shadow.camera.updateProjectionMatrix()
    this.sun.shadow.normalBias = 0.035
    this.sun.shadow.bias = -0.0004

    // 逆光轮廓灯从怪兽后上方打向英雄与怪兽边缘，勾勒金属皮套与怪兽剪影立体感
    this.rim.position.set(16, 26, -34)

    this.dust.visible = false
    this.embers.visible = false
    this.root.add(
      this.sun,
      this.rim,
      this.fill,
      this.contact,
      this.heroContactAO,
      this.kaijuContactAO,
      this.dust,
      this.embers,
      this.fixtures,
    )
    this.scene.add(this.root)
  }

  public getTheme() {
    return this.theme
  }

  public setTheme(theme: ConcreteSceneTheme): Promise<void> {
    if (this.selected === theme) return this.ready
    this.selected = theme
    const revision = ++this.revision
    this.ready = this.load(theme, revision).catch((error) => {
      if (revision === this.revision) this.selected = null
      throw error
    })
    return this.ready
  }

  private async load(theme: ConcreteSceneTheme, revision: number) {
    const surface = theme === 'volcano' ? 'basalt' : theme === 'seaside' ? 'pavement' : null
    const names = surface ? [theme, surface, surface + '-normal'] : [theme]
    const results = await Promise.allSettled(
      names.map((name) => this.loader.loadAsync(`${ASSETS}/${name}.webp`)),
    )
    const maps = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const failure = results.find((r) => r.status === 'rejected')
    if (this.disposed || revision !== this.revision || failure) {
      maps.forEach((texture) => texture.dispose())
      if (failure && !this.disposed && revision === this.revision) throw failure.reason
      return
    }

    this.releaseStage()
    this.theme = theme
    const config = STAGES[theme]
    const texture = maps[0]!
    texture.colorSpace = THREE.SRGBColorSpace
    texture.mapping = THREE.EquirectangularReflectionMapping
    texture.anisotropy = 4

    const yaw = (config.heading - 0.25) * Math.PI * 2
    const sky = new GroundedSkybox(texture, 14.2, 240, 64)
    sky.position.set(3.5, 14.16, 29.5)
    sky.rotation.y = yaw
    sky.renderOrder = -10
    sky.material.toneMapped = false
    this.sky = sky
    this.root.add(sky)

    // 使用 PMREM 预过滤生成多级粗糙度环境贴图，让金属与哑光皮套呈现真实物理光泽
    this.envRenderTarget = this.pmrem.fromEquirectangular(texture)
    this.scene.environment = this.envRenderTarget.texture
    this.scene.environmentRotation.y = yaw
    this.scene.environmentIntensity = theme === 'volcano' ? 0.68 : 0.78

    this.sun.color.setHex(config.light)
    this.sun.intensity = config.power
    this.sun.position.fromArray(config.sun).normalize().multiplyScalar(65)

    this.rim.color.setHex(config.rim)
    this.rim.intensity = config.rimPower

    this.contact.visible = theme === 'mountain' || theme === 'city'
    this.embers.visible = theme === 'volcano'

    if (theme === 'volcano') this.buildCrater(maps[1]!, maps[2]!)
    else if (theme === 'seaside') this.buildQuay(maps[1]!, maps[2]!)
  }

  private buildQuay(map: THREE.Texture, normal: THREE.Texture) {
    const width = 150
    const length = 106
    for (const tex of [map, normal]) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(width / 4, length / 4)
      tex.anisotropy = 8
    }
    map.colorSpace = THREE.SRGBColorSpace
    const surface = new THREE.MeshStandardMaterial({
      map,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.65, 0.65),
      roughness: 0.88,
      color: 0xc8c1b6,
    })
    const geometry = new THREE.PlaneGeometry(width, length)
    geometry.rotateX(-Math.PI / 2)
    this.ground = new THREE.Mesh(geometry, surface)
    this.ground.position.z = 6
    this.ground.receiveShadow = true
    this.root.add(this.ground)

    const metal = new THREE.MeshStandardMaterial({
      color: 0x56504a,
      metalness: 0.68,
      roughness: 0.55,
    })
    const post = new THREE.LatheGeometry(
      [
        new THREE.Vector2(0.64, 0),
        new THREE.Vector2(0.64, 0.13),
        new THREE.Vector2(0.34, 0.18),
        new THREE.Vector2(0.31, 0.72),
        new THREE.Vector2(0.46, 0.78),
        new THREE.Vector2(0.46, 0.87),
        new THREE.Vector2(0, 0.91),
      ],
      16,
    )
    const bollards = new THREE.InstancedMesh(post, metal, 13)
    for (let i = 0; i < 13; i++) {
      bollards.setMatrixAt(i, new THREE.Matrix4().makeTranslation((i - 6) * 11, 0, -40))
    }
    bollards.castShadow = true
    this.fixtures.add(bollards)
  }

  /** 实体火山口围住平坦战斗区，岩面凹处的两条熔流沿坡脚延伸 */
  private buildCrater(map: THREE.Texture, normal: THREE.Texture) {
    const ground = new THREE.PlaneGeometry(260, 240, 160, 144)
    ground.rotateX(-Math.PI / 2)
    const pos = ground.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const noise =
        Math.sin(x * 0.063 + z * 0.09) +
        0.32 * Math.cos(z * 0.24 - x * 0.13) +
        0.15 * Math.sin(x * 0.62 + z * 0.41)
      const rim = Math.hypot(x / 76, (z + 8) / 90)
      const wall = Math.exp(-((rim - 1) ** 2) * 13) * (23 + 6 * noise)
      const edge = THREE.MathUtils.smoothstep(Math.max(Math.abs(x), -z * 0.7), 15, 40)
      pos.setY(i, edge * (wall + 1.6 * noise) - 0.015)
    }
    ground.computeVertexNormals()
    for (const tex of [map, normal]) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(24, 22)
      tex.anisotropy = 4
    }
    map.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.MeshStandardMaterial({ map, normalMap: normal, roughness: 0.89 })
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uHeat = this.heat
      shader.vertexShader =
        'varying vec3 vRock;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n vRock = position;',
        )
      shader.fragmentShader =
        'varying vec3 vRock; uniform float uHeat;\n' +
        shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `
        #include <emissivemap_fragment>
        float bend = 3.*sin(vRock.z*.095) + 1.5*sin(vRock.z*.17 + 1.);
        float left = abs(vRock.x + 20. + bend);
        float right = abs(vRock.x - 17. + 3.*sin(vRock.z*.074 + .5) - .7*bend);
        float channel = min(left, right * 1.6);
        float grit = texture2D(map, vMapUv * .43).r;
        float bank = 3.8 * grit;
        float flow = (1. - smoothstep(.35, 2.1, channel + bank)) * (1.-smoothstep(4.,17.,vRock.y));
        float crust = texture2D(map, vMapUv + vec2(0., uHeat*.027)).r;
        float ember = smoothstep(.025,.15,crust + grit*.3);
        totalEmissiveRadiance += flow * mix(vec3(.38,.016,.002),vec3(3.3,.59,.035),ember);
      `,
        )
    }
    this.ground = new THREE.Mesh(ground, material)
    this.ground.receiveShadow = true
    this.root.add(this.ground)
  }

  public groundImpact(x: number, z: number, elapsed: number) {
    this.impactTime = elapsed
    this.dust.position.set(x, 0.12, z)
    this.dust.material.uniforms.tint!.value.setHex(STAGES[this.theme].dust)
  }

  public update(
    elapsed: number,
    heroPos?: THREE.Vector3,
    kaijuPos?: THREE.Vector3,
    kaijuVisible = true,
  ) {
    this.heat.value = elapsed
    const age = elapsed - this.impactTime
    this.dust.visible = age < 1.25
    this.dust.material.uniforms.age!.value = age
    if (this.embers.visible) {
      this.embers.material.uniforms.uTime!.value = elapsed
    }

    if (heroPos) {
      const hLift = Math.max(0, heroPos.y)
      const hScale = Math.max(0.45, 1 - hLift * 0.055)
      this.heroContactAO.position.set(heroPos.x, 0.025, heroPos.z)
      this.heroContactAO.scale.setScalar(hScale)
      this.heroContactAO.material.opacity = 0.52 * Math.max(0, 1 - hLift * 0.08)
    }
    if (kaijuPos) {
      const kLift = Math.max(0, kaijuPos.y)
      const kScale = Math.max(0.45, 1 - kLift * 0.04)
      this.kaijuContactAO.visible = kaijuVisible
      this.kaijuContactAO.position.set(kaijuPos.x, 0.024, kaijuPos.z)
      this.kaijuContactAO.scale.setScalar(kScale)
      this.kaijuContactAO.material.opacity = 0.58 * Math.max(0, 1 - kLift * 0.06)
    }
  }

  private releaseStage() {
    if (this.sky) {
      this.root.remove(this.sky)
      this.sky.material.map?.dispose()
      this.sky.geometry.dispose()
      this.sky.material.dispose()
      this.sky = null
    }
    while (this.fixtures.children.length > 0) {
      const mesh = this.fixtures.children[0] as THREE.InstancedMesh<
        THREE.BufferGeometry,
        THREE.Material
      >
      mesh.dispose()
      mesh.geometry.dispose()
      mesh.material.dispose()
      this.fixtures.remove(mesh)
    }
    this.scene.environment = null
    this.envRenderTarget?.dispose()
    this.envRenderTarget = null
    if (this.ground) {
      this.root.remove(this.ground)
      this.ground.geometry.dispose()
      this.ground.material.map?.dispose()
      this.ground.material.normalMap?.dispose()
      this.ground.material.dispose()
      this.ground = null
    }
  }

  public dispose() {
    this.disposed = true
    this.releaseStage()
    this.pmrem.dispose()
    this.scene.remove(this.root)
    this.sun.dispose()
    this.rim.dispose()
    this.aoTexture.dispose()
    this.heroContactAO.geometry.dispose()
    this.heroContactAO.material.dispose()
    this.kaijuContactAO.geometry.dispose()
    this.kaijuContactAO.material.dispose()
    this.dust.geometry.dispose()
    this.dust.material.dispose()
    this.embers.geometry.dispose()
    this.embers.material.dispose()
    this.contact.material.dispose()
    this.contact.geometry.dispose()
  }
}

function makeSoftBlobTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 62)
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.85)')
  grad.addColorStop(0.45, 'rgba(0, 0, 0, 0.42)')
  grad.addColorStop(0.8, 'rgba(0, 0, 0, 0.1)')
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(canvas)
}

/** 贴地震波尘团 */
function makeImpactDust() {
  const geometry = new THREE.InstancedBufferGeometry()
  const quad = new THREE.PlaneGeometry(1, 1)
  geometry.setIndex(quad.index)
  geometry.setAttribute('position', quad.getAttribute('position'))
  geometry.setAttribute('uv', quad.getAttribute('uv'))
  const clouds = 32
  const velocities = new Float32Array(clouds * 3)
  for (let i = 0; i < clouds; i++) {
    const angle = i * 2.39996
    const speed = 2.0 + (i % 7) * 0.62
    velocities.set([Math.cos(angle) * speed, 0.28 + (i % 5) * 0.2, Math.sin(angle) * speed], i * 3)
  }
  geometry.instanceCount = clouds
  geometry.setAttribute('velocity', new THREE.InstancedBufferAttribute(velocities, 3))
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { age: { value: 0 }, tint: { value: new THREE.Color() } },
    vertexShader: `
      attribute vec3 velocity;
      uniform float age;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 center = velocity * vec3(1. + age * 1.15, age, 1. + age * 1.15);
        vec4 mv = modelViewMatrix * vec4(center, 1.);
        mv.xy += position.xy * (1.2 + age * 3.6);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float age;
      uniform vec3 tint;
      varying vec2 vUv;
      void main() {
        vec2 q = vUv - .5;
        float radius = length(q) + .035*sin(q.x*24.)*cos(q.y*17.);
        float opacity = (1.-smoothstep(.02,.49,radius)) * (1.-smoothstep(.08,1.25,age));
        gl_FragColor = vec4(tint, opacity*.45);
        #include <colorspace_fragment>
      }`,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  return mesh
}

/** 火山战场升腾火星余烬粒子 */
function makeVolcanoEmbers() {
  const geometry = new THREE.InstancedBufferGeometry()
  const quad = new THREE.PlaneGeometry(0.32, 0.32)
  geometry.setIndex(quad.index)
  geometry.setAttribute('position', quad.getAttribute('position'))
  geometry.setAttribute('uv', quad.getAttribute('uv'))
  const count = 90
  const seeds = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    seeds.set(
      [
        (Math.random() - 0.5) * 62,
        Math.random() * 24,
        (Math.random() - 0.5) * 58 + 4,
        0.5 + Math.random() * 1.2,
      ],
      i * 4,
    )
  }
  geometry.instanceCount = count
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4))
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute vec4 aSeed;
      uniform float uTime;
      varying vec2 vUv;
      varying float vLife;
      void main() {
        vUv = uv;
        float cycle = fract((aSeed.y + uTime * (1.6 * aSeed.w)) / 24.0);
        vLife = cycle;
        vec3 pos = vec3(
          aSeed.x + sin(uTime * 1.4 + aSeed.z) * 1.8,
          cycle * 24.0,
          aSeed.z + cos(uTime * 1.1 + aSeed.x) * 1.4
        );
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        mv.xy += position.xy * (0.6 + aSeed.w * 0.7);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec2 vUv;
      varying float vLife;
      void main() {
        float d = length(vUv - 0.5);
        float glow = smoothstep(0.5, 0.05, d);
        float fade = sin(vLife * 3.14159265);
        vec3 col = mix(vec3(1.0, 0.32, 0.05), vec3(1.0, 0.85, 0.35), glow);
        gl_FragColor = vec4(col, glow * fade * 0.85);
      }`,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  return mesh
}
