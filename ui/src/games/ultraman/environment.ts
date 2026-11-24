import * as THREE from 'three'
import { GroundedSkybox } from 'three/examples/jsm/objects/GroundedSkybox.js'
import type { ConcreteSceneTheme } from './types'

const ASSETS = '/models/ultraman/landscape'
const STAGES = {
  seaside: { heading: 0.48, light: 0xffedcf, power: 2.0, sun: [0.8, 0.72, -0.28], dust: 0xaba498 },
  city: { heading: 0.92, light: 0xe7efff, power: 1.2, sun: [-0.55, 0.9, 0.46], dust: 0xa29991 },
  mountain: { heading: 0.52, light: 0xfff1d2, power: 2.1, sun: [0.53, 1, -0.68], dust: 0x978864 },
  volcano: {
    heading: 0.65,
    light: 0xffb078,
    power: 1.75,
    sun: [-0.65, 0.45, -0.55],
    dust: 0x655451,
  },
} as const

/** 地面投影使脚下透视随镜头移动；远景、反射与地表均来自同一次实景拍摄。 */
export class ArenaManager {
  private theme: ConcreteSceneTheme = 'seaside'
  private selected: ConcreteSceneTheme | null = null
  private ready: Promise<void> = Promise.resolve()
  private revision = 0
  private disposed = false
  private readonly root = new THREE.Group()
  private readonly sun = new THREE.DirectionalLight()
  private readonly fill = new THREE.HemisphereLight(0xe1ebfa, 0x776c62, 0.85)
  private readonly contact = new THREE.Mesh(
    new THREE.PlaneGeometry(100, 110),
    new THREE.ShadowMaterial({ opacity: 0.38, depthWrite: false }),
  )
  private sky: GroundedSkybox | null = null
  private reflection: THREE.Texture | null = null
  private readonly fixtures = new THREE.Group()
  private ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | null = null
  private readonly dust = makeImpactDust()
  private impactTime = -Infinity
  private readonly heat = { value: 0 }
  private readonly loader = new THREE.TextureLoader()

  constructor(private readonly scene: THREE.Scene) {
    this.contact.rotation.x = -Math.PI / 2
    this.contact.position.y = 0.015
    this.contact.receiveShadow = true
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(1024, 1024)
    Object.assign(this.sun.shadow.camera, {
      left: -30,
      right: 30,
      top: 31,
      bottom: -31,
      near: 1,
      far: 155,
    })
    this.sun.shadow.camera.updateProjectionMatrix()
    this.sun.shadow.normalBias = 0.045
    this.dust.visible = false
    this.root.add(this.sun, this.fill, this.contact, this.dust, this.fixtures)
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
    texture.anisotropy = 4
    const yaw = (config.heading - 0.25) * Math.PI * 2
    const sky = new GroundedSkybox(texture, 14.2, 240, 64)
    sky.position.set(5, 14.16, 37.5)
    sky.rotation.y = yaw
    sky.renderOrder = -10
    sky.material.toneMapped = false
    this.sky = sky
    this.root.add(sky)

    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 256
    canvas.getContext('2d')!.drawImage(texture.image as HTMLImageElement, 0, 0, 512, 256)
    this.reflection = new THREE.CanvasTexture(canvas)
    this.reflection.colorSpace = THREE.SRGBColorSpace
    this.reflection.mapping = THREE.EquirectangularReflectionMapping
    this.scene.environment = this.reflection
    this.scene.environmentRotation.y = yaw
    this.scene.environmentIntensity = 0.85
    this.sun.color.setHex(config.light)
    this.sun.intensity = config.power
    this.sun.position.fromArray(config.sun).normalize().multiplyScalar(65)
    this.contact.visible = theme === 'mountain' || theme === 'city'
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
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.88,
      color: 0xcac3b8,
    })
    const geometry = new THREE.PlaneGeometry(width, length)
    geometry.rotateX(-Math.PI / 2)
    this.ground = new THREE.Mesh(geometry, surface)
    this.ground.position.z = 8
    this.ground.receiveShadow = true
    this.root.add(this.ground)

    const metal = new THREE.MeshStandardMaterial({
      color: 0x5d5650,
      metalness: 0.6,
      roughness: 0.65,
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
    for (let i = 0; i < 13; i++)
      bollards.setMatrixAt(i, new THREE.Matrix4().makeTranslation((i - 6) * 11, 0, -44))
    bollards.castShadow = true
    this.fixtures.add(bollards)
  }

  /** 实体火山口围住平坦战斗区，岩面凹处的两条熔流沿坡脚延伸。 */
  private buildCrater(map: THREE.Texture, normal: THREE.Texture) {
    const ground = new THREE.PlaneGeometry(260, 240, 160, 144)
    ground.rotateX(-Math.PI / 2)
    const pos = ground.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i),
        z = pos.getZ(i)
      const noise =
        Math.sin(x * 0.063 + z * 0.09) +
        0.32 * Math.cos(z * 0.24 - x * 0.13) +
        0.15 * Math.sin(x * 0.62 + z * 0.41)
      const rim = Math.hypot(x / 76, (z + 12) / 90)
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

  public update(elapsed: number) {
    this.heat.value = elapsed
    const age = elapsed - this.impactTime
    this.dust.visible = age < 1.25
    this.dust.material.uniforms.age!.value = age
  }

  private releaseStage() {
    if (this.sky) {
      this.root.remove(this.sky)
      this.sky.material.map?.dispose()
      this.sky.geometry.dispose()
      this.sky.material.dispose()
      this.sky = null
    }
    for (const child of [...this.fixtures.children]) {
      const mesh = child as THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>
      mesh.dispose()
      mesh.geometry.dispose()
      mesh.material.dispose()
      this.fixtures.remove(child)
    }
    this.scene.environment = null
    this.reflection?.dispose()
    this.reflection = null
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
    this.scene.remove(this.root)
    this.sun.dispose()
    this.dust.geometry.dispose()
    this.dust.material.dispose()
    this.contact.material.dispose()
    this.contact.geometry.dispose()
  }
}

/** 单次绘制一圈贴地尘团，在视图空间展开，侧视镜头下也能保持体积。 */
function makeImpactDust() {
  const geometry = new THREE.InstancedBufferGeometry()
  const quad = new THREE.PlaneGeometry(1, 1)
  geometry.setIndex(quad.index)
  geometry.setAttribute('position', quad.getAttribute('position'))
  geometry.setAttribute('uv', quad.getAttribute('uv'))
  const clouds = 28
  const velocities = new Float32Array(clouds * 3)
  for (let i = 0; i < clouds; i++) {
    const angle = i * 2.39996
    const speed = 1.8 + (i % 7) * 0.55
    velocities.set([Math.cos(angle) * speed, 0.25 + (i % 5) * 0.18, Math.sin(angle) * speed], i * 3)
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
        vec3 center = velocity * vec3(1. + age, age, 1. + age);
        vec4 mv = modelViewMatrix * vec4(center, 1.);
        mv.xy += position.xy * (1.1 + age * 3.4);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float age;
      uniform vec3 tint;
      varying vec2 vUv;
      void main() {
        vec2 q = vUv - .5;
        float radius = length(q) + .035*sin(q.x*24.)*cos(q.y*17.);
        float opacity = (1.-smoothstep(.02,.49,radius)) * (1.-smoothstep(.1,1.25,age));
        gl_FragColor = vec4(tint, opacity*.42);
        #include <colorspace_fragment>
      }`,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  return mesh
}
