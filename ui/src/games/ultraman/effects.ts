import * as THREE from 'three'
import type { HeroProfile } from './heroes'

interface SparkParticle {
  mesh: THREE.Mesh
  vx: number
  vy: number
  vz: number
  life: number
  maxLife: number
  gravity: number
  baseWidth: number
  lengthFactor: number
}

interface ShockwaveRing {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  life: number
  maxLife: number
  maxRadius: number
}

interface EnergySphereBurst {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>
  life: number
  maxLife: number
  maxScale: number
}

interface MeleeSlashArc {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  life: number
  maxLife: number
  spinZ: number
}

interface HitFlare {
  mesh: THREE.Sprite
  life: number
  maxLife: number
  peakScale: number
  spinSpeed: number
}

export interface Projectile {
  kind: 'punch-wave' | 'kick-wave' | 'palm-bolt' | 'ultra-disc' | 'kaiju-fireball'
  mesh: THREE.Object3D
  pos: THREE.Vector3
  vel: THREE.Vector3
  radius: number
  damage: number
  age: number
  maxAge: number
  fromHero: boolean
  punchSide?: 'left' | 'right'
  finisher?: boolean
  hitTriggered: boolean
}

function makeStarFlareTexture(): THREE.CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const half = size / 2

  const rad = ctx.createRadialGradient(half, half, 0, half, half, half)
  rad.addColorStop(0, 'rgba(255,255,255,1)')
  rad.addColorStop(0.18, 'rgba(255,255,255,0.88)')
  rad.addColorStop(0.45, 'rgba(255,255,255,0.22)')
  rad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = rad
  ctx.fillRect(0, 0, size, size)

  ctx.save()
  ctx.translate(half, half)
  for (let i = 0; i < 2; i++) {
    ctx.rotate(Math.PI / 2)
    const beam = ctx.createLinearGradient(-half, 0, half, 0)
    beam.addColorStop(0, 'rgba(255,255,255,0)')
    beam.addColorStop(0.5, 'rgba(255,255,255,0.95)')
    beam.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = beam
    ctx.beginPath()
    ctx.ellipse(0, 0, half * 0.95, 3.2, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeStreakSparkTexture(): THREE.CanvasTexture {
  const w = 32
  const h = 128
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(w / 2, h * 0.38, 1, w / 2, h / 2, h / 2)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.28, 'rgba(255,255,255,0.88)')
  grad.addColorStop(0.7, 'rgba(255,255,255,0.2)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.save()
  ctx.scale(1, h / w)
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(w / 2, w / 2, w / 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** 构造弧形近战刀光剑气带几何体 */
function buildCurvedSlashGeometry(innerR: number, outerR: number, arcRad: number, segments = 24): THREE.BufferGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  for (let i = 0; i <= segments; i++) {
    const u = i / segments
    const a = (u - 0.5) * arcRad
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    // 两端收尖，中段饱满如锐利月牙刀光
    const taper = Math.sin(u * Math.PI)
    const rIn = THREE.MathUtils.lerp(outerR, innerR, taper)
    positions.push(ca * rIn, sa * rIn, 0)
    uvs.push(u, 0)
    positions.push(ca * outerR, sa * outerR, 0)
    uvs.push(u, 1)
    if (i < segments) {
      const k = i * 2
      indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(indices)
  return geo
}

function createPlasmaBeamMaterial(initialColor: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(initialColor) },
      uTime: { value: 0 },
      uFade: { value: 1 },
      uCoreTightness: { value: 2.2 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;
      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - worldPos.xyz + vec3(0.0001));
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uFade;
      uniform float uCoreTightness;
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;
      void main() {
        float facing = clamp(abs(dot(normalize(vWorldNormal), normalize(vViewDir))), 0.0, 1.0);
        float outerGlow = pow(max(facing, 0.0001), 1.35);
        float hotCore = pow(max(facing, 0.0001), uCoreTightness * 2.1);
        float flow = 0.82 + 0.18 * sin(vUv.y * 34.0 - uTime * 48.0)
                          + 0.12 * cos(vUv.y * 19.0 - uTime * 30.0 + vUv.x * 6.28318);
        float tipSoft = smoothstep(0.0, 0.06, vUv.y) * (1.0 - smoothstep(0.92, 1.0, vUv.y));
        vec3 col = mix(uColor * 1.2, vec3(1.25, 1.38, 1.5), hotCore * 0.88);
        float alpha = (outerGlow * 0.72 + hotCore * 0.56) * flow * tipSoft * uFade;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
      }
    `,
  })
}

/**
 * 影视级特摄战斗特效系统（全面对标悦动元气机）：
 * - 近战连击高曲率红金/青蓝刀光剑气拖尾（Slash Ribbons）
 * - 包裹全身的立体球形蓝色奥特能量穹盾（Fresnel + 六边形扫描 + 受击爆闪波纹）
 * - 命中立体蓝色冲击波能量球 + 电光火石拉伸火花瀑 + 十字耀斑
 * - 远程掌心高速光弹 + 立体烈焰巨型熔岩火球
 * - 七彩棱镜流光全屏蓄力光阵 + 闪电缠绕超级光线 + 猩红毁灭爆裂电弧
 */
export class BattleEffects {
  private readonly group = new THREE.Group()
  private sparks: SparkParticle[] = []
  private shockwaves: ShockwaveRing[] = []
  private energySpheres: EnergySphereBurst[] = []
  private slashes: MeleeSlashArc[] = []
  private flares: HitFlare[] = []
  public projectiles: Projectile[] = []

  private readonly sparkQuadGeo = new THREE.PlaneGeometry(1, 1)
  private readonly shockwaveGeo = new THREE.PlaneGeometry(2, 2)
  private readonly sphereBurstGeo = new THREE.SphereGeometry(1, 20, 16)
  private readonly slashGeo = buildCurvedSlashGeometry(2.4, 5.2, Math.PI * 1.05, 24)
  private readonly flareTex: THREE.CanvasTexture
  private readonly sparkTex: THREE.CanvasTexture

  // 英雄等离子光线组 + 缠绕闪电弧
  private readonly heroBeamGroup = new THREE.Group()
  private readonly heroBeamInner: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>
  private readonly heroBeamOuter: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>
  private readonly heroBeamFilaments: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>[] = []
  private readonly beamLightningLines: THREE.Line[] = []
  private readonly impactArcLines: THREE.Line[] = []
  private readonly heroMuzzleSprite: THREE.Sprite
  private readonly heroImpactSprite: THREE.Sprite
  private heroBeamActive = false
  private heroBeamSuper = false
  private heroBeamColorHex = 0x38d9ff
  private heroBeamTime = 0
  private heroBeamDuration = 1.4

  // 怪兽暗黑破坏光线 & 蓄力能量球
  private readonly kaijuBeamGroup = new THREE.Group()
  private readonly kaijuBeamInner: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>
  private readonly kaijuBeamOuter: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>
  private kaijuBeamTime = 0
  private kaijuBeamDuration = 0.75
  private readonly kaijuChargeSprite: THREE.Sprite

  // 双光线对波交汇奇点球
  private readonly clashGroup = new THREE.Group()
  private readonly clashCore: THREE.Mesh
  private readonly clashFlare: THREE.Sprite
  private clashActive = false
  private clashProgress = 0.5

  // 包裹全身的立体球形蓝色奥特能量穹顶护盾（复刻视频 2 0:04-0:05, 0:23, 0:51）
  private readonly shieldMesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>
  private shieldFlash = 0

  // 七彩棱镜流光蓄力组（复刻视频 1 0:06 全屏七彩能量汇聚！）
  private readonly rainbowGroup = new THREE.Group()
  private readonly rainbowStreaks: {
    mesh: THREE.Mesh
    angle: number
    tilt: number
    phase: number
    radius: number
  }[] = []
  private readonly rainbowHalo: THREE.Sprite

  // 英雄蓄力预览
  private readonly chargeSprite: THREE.Sprite
  private readonly chargeDiscPreview: THREE.Group
  private readonly typeChargeSprite: THREE.Sprite

  // 全息扫描地面危险预警阵
  private readonly warningRing: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>

  private readonly upAxis = new THREE.Vector3(0, 1, 0)
  private readonly tmpDir = new THREE.Vector3()

  private themeBeamColor = 0x38d9ff
  private themeBeamSuperColor = 0xfacc15
  private themeDiscColor = 0x38e8ff
  private themeBurstColor = 0x67e8f9

  constructor(scene: THREE.Scene) {
    this.group.name = 'BattleEffects'
    scene.add(this.group)

    this.flareTex = makeStarFlareTexture()
    this.sparkTex = makeStreakSparkTexture()

    // 1. 英雄等离子光线 + 闪电弧
    const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true)
    this.heroBeamInner = new THREE.Mesh(cylGeo, createPlasmaBeamMaterial(0xffffff))
    this.heroBeamInner.material.uniforms.uCoreTightness!.value = 3.2
    this.heroBeamOuter = new THREE.Mesh(cylGeo, createPlasmaBeamMaterial(0x38d9ff))
    this.heroBeamOuter.material.uniforms.uCoreTightness!.value = 1.35
    this.heroBeamGroup.add(this.heroBeamInner, this.heroBeamOuter)

    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(
        cylGeo,
        new THREE.MeshBasicMaterial({
          color: i % 2 === 0 ? 0xe0f7ff : 0xfef08a,
          transparent: true,
          opacity: 0.65,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      this.heroBeamGroup.add(f)
      this.heroBeamFilaments.push(f)
    }

    // 缠绕主光束的高能电弧闪电 + 命中端狂飙的红色毁灭闪电（视频 1 0:07-0:09）
    for (let i = 0; i < 4; i++) {
      const pts = new Float32Array(12 * 3)
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
      const line = new THREE.Line(
        g,
        new THREE.LineBasicMaterial({
          color: i % 2 === 0 ? 0x93c5fd : 0xe879f9,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
        }),
      )
      this.heroBeamGroup.add(line)
      this.beamLightningLines.push(line)
    }
    for (let i = 0; i < 6; i++) {
      const pts = new Float32Array(7 * 3)
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
      const line = new THREE.Line(
        g,
        new THREE.LineBasicMaterial({
          color: i % 2 === 0 ? 0xff2e63 : 0xfde047,
          transparent: true,
          opacity: 0.92,
          blending: THREE.AdditiveBlending,
        }),
      )
      this.heroBeamGroup.add(line)
      this.impactArcLines.push(line)
    }

    this.heroMuzzleSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: 0xe0f7ff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.heroImpactSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: 0x7dd3fc,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.heroBeamGroup.add(this.heroMuzzleSprite, this.heroImpactSprite)
    this.heroBeamGroup.visible = false
    this.group.add(this.heroBeamGroup)

    // 2. 怪兽暗黑破坏光线 & 蓄力球
    this.kaijuBeamInner = new THREE.Mesh(cylGeo, createPlasmaBeamMaterial(0xffd6ff))
    this.kaijuBeamInner.material.uniforms.uCoreTightness!.value = 3.0
    this.kaijuBeamOuter = new THREE.Mesh(cylGeo, createPlasmaBeamMaterial(0xa855f7))
    this.kaijuBeamOuter.material.uniforms.uCoreTightness!.value = 1.35
    this.kaijuBeamGroup.add(this.kaijuBeamInner, this.kaijuBeamOuter)
    this.kaijuBeamGroup.visible = false
    this.group.add(this.kaijuBeamGroup)

    this.kaijuChargeSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: 0xff6b35,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.kaijuChargeSprite.visible = false
    this.group.add(this.kaijuChargeSprite)

    // 3. 双光线对波奇点球
    this.clashCore = new THREE.Mesh(
      new THREE.SphereGeometry(1, 18, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.clashFlare = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: 0xfef08a,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.clashGroup.add(this.clashCore, this.clashFlare)
    this.clashGroup.visible = false
    this.group.add(this.clashGroup)

    // 4. 包裹全身的通透立体球形蓝色奥特能量穹盾（精准包裹身躯、边缘高能泛光、核心通透绝不泛白遮屏）
    this.shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(5.6, 32, 24),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uFlash: { value: 0 },
          uColor: { value: new THREE.Color(0x22b8ff) },
        },
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vNormal;
          varying vec3 vViewDir;
          varying vec3 vLocalPos;
          void main() {
            vUv = uv;
            vLocalPos = position;
            vec4 worldPos = modelMatrix * vec4(position, 1.0);
            vNormal = normalize(mat3(modelMatrix) * normal);
            vViewDir = normalize(cameraPosition - worldPos.xyz + vec3(0.0001));
            gl_Position = projectionMatrix * viewMatrix * worldPos;
          }
        `,
        fragmentShader: `
          uniform float uTime;
          uniform float uFlash;
          uniform vec3 uColor;
          varying vec2 vUv;
          varying vec3 vNormal;
          varying vec3 vViewDir;
          varying vec3 vLocalPos;

          float hexDist(vec2 p) {
            p = abs(p);
            return max(dot(p, normalize(vec2(1.0, 1.73205))), p.x);
          }

          void main() {
            float ndotv = clamp(abs(dot(normalize(vNormal), normalize(vViewDir))), 0.0, 1.0);
            float fresnel = pow(max(1.0 - ndotv, 0.0001), 2.65);

            vec2 gv = vec2(vUv.x * 20.0, vUv.y * 11.0);
            vec2 r = vec2(1.0, 1.73205);
            vec2 h = r * 0.5;
            vec2 a = mod(gv, r) - h;
            vec2 b = mod(gv - h, r) - h;
            vec2 cell = dot(a, a) < dot(b, b) ? a : b;
            float cellEdge = smoothstep(0.43, 0.495, hexDist(cell));

            float groundFade = smoothstep(-5.1, -2.6, vLocalPos.y);
            float scan = 0.55 + 0.45 * sin(vLocalPos.y * 1.6 - uTime * 7.5);
            float ripple = uFlash * (0.5 + 0.5 * sin(length(vLocalPos.xy) * 2.4 - uTime * 28.0));

            vec3 baseCol = mix(uColor * 1.05, vec3(0.85, 1.25, 1.55), fresnel * 0.55 + uFlash * 0.65);
            float alpha = (0.04 + cellEdge * 0.16 * scan + fresnel * 0.64 + ripple * 0.38) * groundFade;
            gl_FragColor = vec4(baseCol, clamp(alpha, 0.0, 0.78));
          }
        `,
      }),
    )
    this.shieldMesh.visible = false
    this.group.add(this.shieldMesh)

    // 5. 七彩棱镜全屏蓄力光条（复刻视频 1 00:06）
    const rainbowPalette = [0x38e8ff, 0xfacc15, 0xf472b6, 0xa855f7, 0x4ade80, 0x60a5fa, 0xfb923c]
    const streakGeo = new THREE.PlaneGeometry(0.48, 8.5)
    for (let i = 0; i < 24; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.sparkTex,
        color: rainbowPalette[i % rainbowPalette.length],
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const m = new THREE.Mesh(streakGeo, mat)
      this.rainbowGroup.add(m)
      this.rainbowStreaks.push({
        mesh: m,
        angle: (i / 24) * Math.PI * 2,
        tilt: ((i % 5) - 2) * 0.24,
        phase: (i * 0.37) % 1,
        radius: 9 + (i % 4) * 3.2,
      })
    }
    this.rainbowHalo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.26,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.rainbowHalo.position.set(0, 0, 1.2)
    this.rainbowGroup.add(this.rainbowHalo)
    this.rainbowGroup.visible = false
    this.group.add(this.rainbowGroup)

    // 6. 英雄蓄力星芒与光轮预览
    this.chargeSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: 0x38e8ff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.chargeSprite.visible = false
    this.group.add(this.chargeSprite)

    this.chargeDiscPreview = this.createSawDiscMesh(1.7)
    this.chargeDiscPreview.visible = false
    this.group.add(this.chargeDiscPreview)

    this.typeChargeSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: 0xc084fc,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.typeChargeSprite.visible = false
    this.group.add(this.typeChargeSprite)

    // 7. 全息扫描地面危险预警法阵
    this.warningRing = new THREE.Mesh(
      new THREE.PlaneGeometry(11.5, 11.5),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uUrgency: { value: 0 },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform float uTime;
          uniform float uUrgency;
          varying vec2 vUv;
          void main() {
            vec2 q = (vUv - 0.5) * 2.0;
            float r = length(q);
            if (r > 1.0) discard;
            float angle = atan(q.y, q.x);
            float dash = step(0.35, fract((angle / 6.28318) * 16.0 + uTime * 0.8));
            float outerRing = smoothstep(0.86, 0.91, r) * (1.0 - smoothstep(0.94, 0.99, r)) * dash;
            float lockR = mix(0.88, 0.16, clamp(uUrgency, 0.0, 1.0));
            float innerLock = exp(-pow(max(abs(r - lockR) * 26.0, 0.0001), 2.0));
            float softFill = (1.0 - smoothstep(0.0, 0.92, r)) * 0.14 * (0.6 + 0.4 * sin(uTime * 16.0));
            vec3 col = mix(vec3(1.1, 0.28, 0.18), vec3(1.3, 0.92, 0.35), innerLock * 0.7);
            float alpha = clamp(outerRing * 0.85 + innerLock * 0.95 + softFill, 0.0, 1.0);
            gl_FragColor = vec4(col, alpha);
          }
        `,
      }),
    )
    this.warningRing.rotation.x = -Math.PI / 2
    this.warningRing.position.set(0, 0.08, 13.2)
    this.warningRing.visible = false
    this.group.add(this.warningRing)
  }

  public setHeroTheme(profile: HeroProfile) {
    this.themeBeamColor = profile.beamColor
    this.themeBeamSuperColor = profile.beamSuperColor
    this.themeDiscColor = profile.discColor
    this.themeBurstColor = profile.burstColor
    this.chargeSprite.material.color.setHex(profile.accentColor)
    this.shieldMesh.material.uniforms.uColor!.value.setHex(profile.accentColor)
    this.chargeDiscPreview.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const mat = (node as THREE.Mesh).material
        if (mat instanceof THREE.MeshBasicMaterial && node.name === 'discOuter') {
          mat.color.setHex(profile.discColor)
        }
      }
    })
  }

  private createSawDiscMesh(radius: number): THREE.Group {
    const g = new THREE.Group()
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.42, radius, 32),
      new THREE.MeshBasicMaterial({
        color: this.themeDiscColor,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    ring.name = 'discOuter'
    ring.rotation.x = -Math.PI / 2
    const core = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.15, radius * 0.52, 24),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.96,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    core.rotation.x = -Math.PI / 2
    g.add(ring, core)

    const toothGeo = new THREE.ConeGeometry(radius * 0.18, radius * 0.52, 4)
    const toothMat = new THREE.MeshBasicMaterial({
      color: 0xe0f7ff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      const tooth = new THREE.Mesh(toothGeo, toothMat)
      tooth.position.set(Math.cos(a) * radius * 1.04, 0, Math.sin(a) * radius * 1.04)
      tooth.rotation.z = -Math.PI / 2
      tooth.rotation.y = -a + 0.35
      g.add(tooth)
    }
    return g
  }

  /** 生成近战高饱和弧形光刃斩击拖尾（复刻视频 2 红金/冰蓝刀光拳风） */
  public spawnMeleeSlash(
    center: THREE.Vector3,
    colorHex: number,
    euler: [number, number, number],
    scale = 1.15,
    spinDir = 1,
  ) {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(colorHex) },
        uProgress: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uProgress;
        varying vec2 vUv;
        void main() {
          // 沿弧线高速扫过的高光前沿 + 锋利边缘衰减
          float head = clamp(uProgress * 1.65, 0.0, 1.15);
          float sweep = smoothstep(head - 0.85, head, vUv.x) * (1.0 - smoothstep(head, head + 0.14, vUv.x));
          float bladeEdge = smoothstep(0.0, 0.72, vUv.y);
          float hotRidge = pow(max(vUv.y, 0.0001), 3.2);
          float fade = pow(max(1.0 - clamp(uProgress, 0.0, 1.0), 0.0001), 1.35);
          vec3 col = mix(uColor * 1.45, vec3(1.85, 1.75, 1.45), hotRidge * 0.85);
          float alpha = sweep * bladeEdge * fade * 0.96;
          if (alpha < 0.02) discard;
          gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
        }
      `,
    })
    const mesh = new THREE.Mesh(this.slashGeo, mat)
    mesh.position.copy(center)
    mesh.rotation.set(euler[0], euler[1], euler[2])
    mesh.scale.setScalar(scale)
    this.group.add(mesh)
    this.slashes.push({ mesh, life: 0, maxLife: 0.24, spinZ: spinDir * 4.2 })
  }

  /** 命中爆裂的立体蓝色/金色能量冲击球（复刻视频 1 00:04 拳击怪兽的巨大能量波球） */
  public spawnEnergyShockSphere(pos: THREE.Vector3, colorHex = 0x38bdf8, maxScale = 4.6) {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(colorHex) },
        uProgress: { value: 0 },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vNormal = normalize(mat3(modelMatrix) * normal);
          vViewDir = normalize(cameraPosition - wp.xyz + vec3(0.0001));
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uProgress;
        varying vec3 vNormal;
        varying vec3 vViewDir;
        void main() {
          float ndotv = clamp(abs(dot(normalize(vNormal), normalize(vViewDir))), 0.0, 1.0);
          float rim = pow(max(1.0 - ndotv, 0.0001), 1.85);
          float fade = pow(max(1.0 - clamp(uProgress, 0.0, 1.0), 0.0001), 1.5);
          vec3 col = mix(uColor * 1.4, vec3(1.6, 1.75, 1.9), rim * 0.7);
          gl_FragColor = vec4(col, clamp((0.18 + rim * 0.82) * fade, 0.0, 1.0));
        }
      `,
    })
    const mesh = new THREE.Mesh(this.sphereBurstGeo, mat)
    mesh.position.copy(pos)
    mesh.scale.setScalar(0.5)
    this.group.add(mesh)
    this.energySpheres.push({ mesh, life: 0, maxLife: 0.28, maxScale })
  }

  /** 更新七彩棱镜流光全屏蓄力特效（视频 1 00:06，从四周飞向英雄背后汇聚，绝不糊脸） */
  public updateRainbowGather(active: boolean, center: THREE.Vector3, progress: number, elapsed: number) {
    this.rainbowGroup.visible = active
    if (!active) return
    this.rainbowGroup.position.copy(center)
    const speed = 1.6 + progress * 2.6
    for (const s of this.rainbowStreaks) {
      const t = (s.phase + elapsed * speed) % 1
      // 从外围向后背外环高速吸入，收束于半径 2.1m 外围，让英雄五官与胸甲始终锐利通透
      const dist = THREE.MathUtils.lerp(s.radius * (1.28 - progress * 0.18), 2.1, t)
      const a = s.angle + elapsed * 0.42
      s.mesh.position.set(
        Math.cos(a) * dist,
        Math.sin(a) * dist * 0.72 + s.tilt * dist * 0.35,
        0.6 + Math.abs(Math.sin(a * 1.7)) * 2.2,
      )
      s.mesh.rotation.set(0, 0, a + Math.PI * 0.5)
      const len = (0.65 + progress * 1.05) * Math.sin(t * Math.PI)
      s.mesh.scale.set(0.65 + progress * 0.55, Math.max(0.12, len), 1)
    }
    this.rainbowHalo.scale.setScalar(2.2 + progress * 3.6 + Math.sin(elapsed * 22) * 0.35)
    this.rainbowHalo.material.rotation = elapsed * 4.6
  }

  public startHeroBeam(isSuper: boolean, durationOverride?: number) {
    this.heroBeamActive = true
    this.heroBeamSuper = isSuper
    this.heroBeamTime = 0
    this.heroBeamDuration = durationOverride ?? (isSuper ? 2.1 : 1.35)
    this.heroBeamGroup.visible = true
    const colorHex = isSuper ? this.themeBeamSuperColor : this.themeBeamColor
    this.heroBeamColorHex = colorHex
    this.heroBeamOuter.material.uniforms.uColor!.value.setHex(colorHex)
    this.heroBeamInner.material.uniforms.uColor!.value.setHex(0xffffff)
    this.heroImpactSprite.material.color.setHex(isSuper ? 0xfef08a : colorHex)
  }

  public stopHeroBeam() {
    this.heroBeamActive = false
    this.heroBeamGroup.visible = false
  }

  public isHeroBeamActive(): boolean {
    return this.heroBeamActive
  }

  public startKaijuBeam(accentColor: number, duration = 0.78) {
    this.kaijuBeamTime = 0.001
    this.kaijuBeamDuration = duration
    this.kaijuBeamGroup.visible = true
    this.kaijuBeamOuter.material.uniforms.uColor!.value.setHex(accentColor)
  }

  public stopKaijuBeam() {
    this.kaijuBeamTime = 0
    this.kaijuBeamGroup.visible = false
  }

  public setBeamClash(active: boolean, progress: number) {
    this.clashActive = active
    this.clashProgress = THREE.MathUtils.clamp(progress, 0.08, 0.95)
    this.clashGroup.visible = active
  }

  public updateKaijuChargeOrb(
    visible: boolean,
    pos: THREE.Vector3,
    progress: number,
    colorHex: number,
    elapsed: number,
  ) {
    this.kaijuChargeSprite.visible = visible
    if (!visible) return
    this.kaijuChargeSprite.position.copy(pos)
    this.kaijuChargeSprite.material.color.setHex(colorHex)
    this.kaijuChargeSprite.material.rotation = elapsed * 4.5
    const s = (1.5 + progress * 4.8) * (0.9 + 0.14 * Math.sin(elapsed * 24))
    this.kaijuChargeSprite.scale.set(s, s, 1)
  }

  /** 发射出拳高速破空光弧 */
  public spawnPunchWave(
    origin: THREE.Vector3,
    target: THREE.Vector3,
    damage: number,
    side: 'left' | 'right',
    finisher: boolean,
  ) {
    const radius = finisher ? 1.55 : 0.95
    const wave = new THREE.Mesh(
      new THREE.TorusGeometry(radius, finisher ? 0.18 : 0.11, 8, 28, Math.PI * 1.35),
      new THREE.MeshBasicMaterial({
        color: finisher ? 0xffd166 : this.themeBurstColor,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    wave.position.copy(origin)
    wave.lookAt(target)
    wave.rotation.z = side === 'left' ? -0.45 : Math.PI + 0.45
    this.group.add(wave)

    const vel = target.clone().sub(origin).multiplyScalar(1 / 0.07)
    this.projectiles.push({
      kind: 'punch-wave',
      punchSide: side,
      finisher,
      mesh: wave,
      pos: origin.clone(),
      vel,
      radius: 2.8,
      damage,
      age: 0,
      maxAge: 0.42,
      fromHero: true,
      hitTriggered: false,
    })
  }

  /** 远程阶段掌心连发奥特光弹（复刻视频 2 0:39-1:03） */
  public spawnPalmBolt(
    origin: THREE.Vector3,
    target: THREE.Vector3,
    damage: number,
    side: 'left' | 'right',
  ) {
    const grp = new THREE.Group()
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.68, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    )
    core.scale.set(0.85, 0.85, 2.3)
    const aura = new THREE.Mesh(
      new THREE.SphereGeometry(1.15, 12, 10),
      new THREE.MeshBasicMaterial({
        color: this.themeBeamColor,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    aura.scale.set(0.95, 0.95, 2.5)
    const flare = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: this.themeBeamColor,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    flare.scale.set(4.2, 4.2, 1)
    grp.add(core, aura, flare)
    grp.position.copy(origin)
    grp.lookAt(target)
    this.group.add(grp)

    const vel = target.clone().sub(origin).normalize().multiplyScalar(62)
    this.projectiles.push({
      kind: 'palm-bolt',
      punchSide: side,
      mesh: grp,
      pos: origin.clone(),
      vel,
      radius: 2.6,
      damage,
      age: 0,
      maxAge: 1.2,
      fromHero: true,
      hitTriggered: false,
    })
  }

  /** 发射奥特飞踢烈焰旋风斩 */
  public spawnKickWave(origin: THREE.Vector3, target: THREE.Vector3, damage: number) {
    const grp = new THREE.Group()
    const outer = new THREE.Mesh(
      new THREE.TorusGeometry(1.45, 0.18, 8, 24),
      new THREE.MeshBasicMaterial({
        color: 0xf97316,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    const inner = new THREE.Mesh(
      new THREE.TorusGeometry(0.88, 0.12, 8, 20),
      new THREE.MeshBasicMaterial({
        color: 0xfef08a,
        transparent: true,
        opacity: 0.96,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    grp.add(outer, inner)
    grp.position.copy(origin)
    grp.lookAt(target)
    this.group.add(grp)

    const vel = target.clone().sub(origin).multiplyScalar(1 / 0.085)
    this.projectiles.push({
      kind: 'kick-wave',
      mesh: grp,
      pos: origin.clone(),
      vel,
      radius: 3.2,
      damage,
      age: 0,
      maxAge: 0.55,
      fromHero: true,
      hitTriggered: false,
    })
  }

  public spawnUltraDisc(origin: THREE.Vector3, target: THREE.Vector3, damage: number) {
    const disc = this.createSawDiscMesh(2.2)
    disc.position.copy(origin)
    this.group.add(disc)

    const vel = target.clone().sub(origin).normalize().multiplyScalar(66)
    this.projectiles.push({
      kind: 'ultra-disc',
      mesh: disc,
      pos: origin.clone(),
      vel,
      radius: 3.4,
      damage,
      age: 0,
      maxAge: 1.1,
      fromHero: true,
      hitTriggered: false,
    })
  }

  /** 巨型炽热熔岩火球（复刻视频 2 0:46-1:02 铺天盖地的火焰巨弹！） */
  public spawnKaijuFireball(
    origin: THREE.Vector3,
    target: THREE.Vector3,
    colorHex: number,
    damage: number,
    speed = 24,
  ) {
    const fireball = new THREE.Group()
    const inner = new THREE.Mesh(
      new THREE.SphereGeometry(1.45, 16, 14),
      new THREE.MeshBasicMaterial({ color: 0xfff8d6 }),
    )
    const outer = new THREE.Mesh(
      new THREE.SphereGeometry(2.35, 16, 14),
      new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: 0xff6b24,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    halo.scale.set(7.6, 7.6, 1)
    fireball.add(inner, outer, halo)
    fireball.position.copy(origin)
    this.group.add(fireball)

    const vel = target.clone().sub(origin).normalize().multiplyScalar(speed)
    this.projectiles.push({
      kind: 'kaiju-fireball',
      mesh: fireball,
      pos: origin.clone(),
      vel,
      radius: 2.9,
      damage,
      age: 0,
      maxAge: 2.8,
      fromHero: false,
      hitTriggered: false,
    })
  }

  /** 生成特摄电光火石拉伸火花条 */
  public spawnBurst(
    pos: THREE.Vector3,
    colorHex: number,
    count = 16,
    speed = 22,
    scale = 1.0,
  ) {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.sparkTex,
        color: i % 3 === 0 ? 0xffffff : i % 3 === 1 ? 0xfff3b0 : colorHex,
        transparent: true,
        opacity: 1,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const mesh = new THREE.Mesh(this.sparkQuadGeo, mat)
      mesh.position.copy(pos)
      this.group.add(mesh)

      const theta = Math.random() * Math.PI * 2
      const phi = (Math.random() - 0.32) * Math.PI * 0.85
      const spd = speed * (0.55 + Math.random() * 0.95)
      this.sparks.push({
        mesh,
        vx: Math.cos(theta) * Math.cos(phi) * spd,
        vy: Math.sin(phi) * spd + speed * 0.24,
        vz: Math.sin(theta) * Math.cos(phi) * spd,
        life: 0,
        maxLife: 0.24 + Math.random() * 0.28,
        gravity: 28,
        baseWidth: (0.24 + Math.random() * 0.24) * scale,
        lengthFactor: (1.4 + Math.random() * 1.45) * scale,
      })
    }
  }

  public triggerShieldBlockFlash() {
    this.shieldFlash = 1
  }

  /** 刀锋锐利空气震波细环 */
  public spawnImpactRing(pos: THREE.Vector3, colorHex: number, maxRadius = 6.5) {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(colorHex) },
        uProgress: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uProgress;
        varying vec2 vUv;
        void main() {
          float r = length((vUv - 0.5) * 2.0);
          if (r > 1.0) discard;
          float edge = exp(-pow(max(abs(r - 0.92) * 28.0, 0.0001), 2.0));
          float wake = smoothstep(0.62, 0.92, r) * (1.0 - smoothstep(0.92, 0.98, r)) * 0.35;
          float fade = pow(max(1.0 - clamp(uProgress, 0.0, 1.0), 0.0001), 1.6);
          vec3 col = mix(uColor * 1.35, vec3(1.5), edge * 0.75);
          gl_FragColor = vec4(col, clamp((edge + wake) * fade, 0.0, 1.0));
        }
      `,
    })
    const mesh = new THREE.Mesh(this.shockwaveGeo, mat)
    mesh.position.copy(pos)
    mesh.scale.setScalar(0.35)
    this.group.add(mesh)
    this.shockwaves.push({ mesh, life: 0, maxLife: 0.26, maxRadius })
  }

  public spawnHitFlash(pos: THREE.Vector3, colorHex: number, scale = 1) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: colorHex,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        rotation: Math.random() * Math.PI,
      }),
    )
    sprite.position.copy(pos)
    sprite.scale.setScalar(1.2 * scale)
    this.group.add(sprite)
    this.flares.push({
      mesh: sprite,
      life: 0,
      maxLife: 0.19,
      peakScale: 5.8 * scale,
      spinSpeed: (Math.random() > 0.5 ? 1 : -1) * 5.5,
    })
  }

  /** 包裹全身的球形奥特能量护盾实时同步 */
  public updateShield(
    active: boolean,
    heroX: number,
    heroZ: number,
    dt: number,
    elapsed: number,
    _sideSign: 1 | -1 = 1,
  ) {
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 3.2)
    this.shieldMesh.visible = active || this.shieldFlash > 0.04
    if (!this.shieldMesh.visible) return
    this.shieldMesh.position.set(heroX, 7.2, heroZ)
    const pulse = 1 + Math.sin(elapsed * 12) * 0.025 + this.shieldFlash * 0.14
    this.shieldMesh.scale.setScalar(pulse)
    this.shieldMesh.rotation.y = elapsed * 0.45
    this.shieldMesh.material.uniforms.uTime!.value = elapsed
    this.shieldMesh.material.uniforms.uFlash!.value = this.shieldFlash
  }

  public updateChargePreview(
    beamCharge: number,
    beamPos: THREE.Vector3,
    discCharge: number,
    discPos: THREE.Vector3,
    elapsed: number,
  ) {
    if (beamCharge > 0.05 && !this.heroBeamActive) {
      this.chargeSprite.visible = true
      this.chargeSprite.position.copy(beamPos)
      this.chargeSprite.material.rotation = elapsed * 5.5
      const s = 1.6 + beamCharge * 4.4 + Math.sin(elapsed * 26) * 0.35
      this.chargeSprite.scale.set(s, s, 1)
    } else {
      this.chargeSprite.visible = false
    }

    if (discCharge > 0.08) {
      this.chargeDiscPreview.visible = true
      this.chargeDiscPreview.position.copy(discPos)
      this.chargeDiscPreview.scale.setScalar(0.35 + discCharge * 0.85)
      this.chargeDiscPreview.rotation.y += 0.32
    } else {
      this.chargeDiscPreview.visible = false
    }
  }

  public updateTypeCharge(
    charge: number,
    pos: THREE.Vector3,
    colorHex: number,
    elapsed: number,
  ) {
    if (charge > 0.03) {
      this.typeChargeSprite.visible = true
      this.typeChargeSprite.position.copy(pos)
      this.typeChargeSprite.material.color.setHex(colorHex)
      this.typeChargeSprite.material.rotation = -elapsed * 6.0
      const s = 2.0 + charge * 5.8 + Math.sin(elapsed * 22) * 0.4 * charge
      this.typeChargeSprite.scale.set(s, s, 1)
    } else {
      this.typeChargeSprite.visible = false
    }
  }

  public updateWarningRing(
    visible: boolean,
    heroX: number,
    heroZ: number,
    urgency: number,
    elapsed: number,
  ) {
    this.warningRing.visible = visible
    if (!visible) return
    this.warningRing.position.set(heroX, 0.28, heroZ - 2.4)
    this.warningRing.material.uniforms.uTime!.value = elapsed
    this.warningRing.material.uniforms.uUrgency!.value = urgency
  }

  private alignCylinder(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3, radius: number) {
    const dir = to.clone().sub(from)
    const len = Math.max(0.01, dir.length())
    mesh.position.copy(from).addScaledVector(dir, 0.5)
    mesh.quaternion.setFromUnitVectors(this.upAxis, dir.normalize())
    mesh.scale.set(radius, len, radius)
  }

  /** 动态更新缠绕光柱的高频折线闪电与命中猩红毁灭电弧 */
  private updateBeamLightning(from: THREE.Vector3, to: THREE.Vector3, radius: number, fade: number) {
    const dir = to.clone().sub(from)
    const len = Math.max(0.5, dir.length())
    dir.normalize()
    const perpA = new THREE.Vector3().crossVectors(dir, this.upAxis)
    if (perpA.lengthSq() < 0.01) perpA.set(1, 0, 0)
    perpA.normalize()
    const perpB = new THREE.Vector3().crossVectors(dir, perpA).normalize()

    for (const line of this.beamLightningLines) {
      const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute
      const count = attr.count
      for (let j = 0; j < count; j++) {
        const t = j / (count - 1)
        const jitter = t > 0 && t < 1 ? radius * (0.9 + Math.random() * 1.1) : 0
        const ang = Math.random() * Math.PI * 2
        const px = from.x + dir.x * len * t + (perpA.x * Math.cos(ang) + perpB.x * Math.sin(ang)) * jitter
        const py = from.y + dir.y * len * t + (perpA.y * Math.cos(ang) + perpB.y * Math.sin(ang)) * jitter
        const pz = from.z + dir.z * len * t + (perpA.z * Math.cos(ang) + perpB.z * Math.sin(ang)) * jitter
        attr.setXYZ(j, px, py, pz)
      }
      attr.needsUpdate = true
      ;(line.material as THREE.LineBasicMaterial).opacity = 0.85 * fade
    }

    for (const line of this.impactArcLines) {
      const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute
      const count = attr.count
      const theta = Math.random() * Math.PI * 2
      const phi = (Math.random() - 0.5) * Math.PI * 0.85
      const arcDir = new THREE.Vector3(
        Math.cos(theta) * Math.cos(phi),
        Math.sin(phi),
        Math.sin(theta) * Math.cos(phi),
      )
      const reach = (this.heroBeamSuper ? 8.5 : 5.2) * (0.65 + Math.random() * 0.55)
      for (let j = 0; j < count; j++) {
        const t = j / (count - 1)
        const jag = t > 0 ? 1.35 * (Math.random() - 0.5) : 0
        attr.setXYZ(
          j,
          to.x + arcDir.x * reach * t + jag,
          to.y + arcDir.y * reach * t + jag,
          to.z + arcDir.z * reach * t + jag,
        )
      }
      attr.needsUpdate = true
      ;(line.material as THREE.LineBasicMaterial).opacity = 0.92 * fade
    }
  }

  public update(
    dt: number,
    elapsed: number,
    heroBeamSegment: [THREE.Vector3, THREE.Vector3],
    kaijuTarget: THREE.Vector3,
    kaijuEmit: THREE.Vector3,
    heroCenter: THREE.Vector3,
    cameraQuat?: THREE.Quaternion,
  ) {
    const heroOrigin = heroBeamSegment[0].clone().lerp(heroBeamSegment[1], 0.58)
    const clashPoint = heroOrigin.clone().lerp(kaijuEmit, this.clashProgress)

    // 1. 英雄等离子必杀光线
    if (this.heroBeamActive) {
      this.heroBeamTime += dt
      const progress = this.heroBeamTime / this.heroBeamDuration
      if (progress >= 1 && !this.clashActive) {
        this.heroBeamActive = false
        this.heroBeamGroup.visible = false
      } else {
        const reveal = this.clashActive ? 1 : Math.min(1, this.heroBeamTime / 0.1)
        const fade =
          this.clashActive || progress <= 0.8 ? 1 : Math.max(0, (1 - progress) / 0.2)
        const targetEnd = this.clashActive ? clashPoint : kaijuTarget
        const end = heroOrigin.clone().lerp(targetEnd, reveal)
        const baseR = this.heroBeamSuper ? 1.48 : 0.92
        const pulse = 1 + Math.sin(elapsed * 46) * 0.12

        this.heroBeamInner.material.uniforms.uTime!.value = elapsed
        this.heroBeamInner.material.uniforms.uFade!.value = fade
        this.heroBeamOuter.material.uniforms.uTime!.value = elapsed
        this.heroBeamOuter.material.uniforms.uFade!.value = fade

        this.alignCylinder(this.heroBeamInner, heroOrigin, end, baseR * 0.45 * pulse)
        this.alignCylinder(this.heroBeamOuter, heroOrigin, end, baseR * 1.18 * pulse)

        this.heroBeamFilaments.forEach((f, idx) => {
          const t = (idx + 0.5) / this.heroBeamFilaments.length
          const startPt = heroBeamSegment[0].clone().lerp(heroBeamSegment[1], t)
          const ang = elapsed * 20 + idx * 1.57
          const offset = new THREE.Vector3(Math.cos(ang), Math.sin(ang), 0).multiplyScalar(
            baseR * 0.55 * fade,
          )
          const farPt = end.clone().add(offset)
          this.alignCylinder(f, startPt, farPt, baseR * 0.1 * fade)
          f.material.opacity = 0.6 * fade
        })

        this.updateBeamLightning(heroOrigin, end, baseR, fade)

        this.heroMuzzleSprite.position.copy(heroOrigin)
        this.heroMuzzleSprite.material.rotation = elapsed * 8
        const mScale = (baseR * 3.8 + Math.sin(elapsed * 32) * 0.45) * fade
        this.heroMuzzleSprite.scale.set(mScale, mScale, 1)

        this.heroImpactSprite.position.copy(end)
        this.heroImpactSprite.material.rotation = -elapsed * 10
        const iScale = (baseR * 6.4 + Math.cos(elapsed * 36) * 0.8) * fade
        this.heroImpactSprite.scale.set(iScale, iScale, 1)

        if (reveal > 0.8 && Math.random() < 0.78) {
          this.spawnBurst(
            end,
            Math.random() < 0.35 ? 0xff2e63 : this.heroBeamColorHex,
            3,
            28,
            this.heroBeamSuper ? 1.25 : 0.9,
          )
        }
      }
    }

    // 2. 怪兽暗黑破坏光线 & 双光线对波奇点
    if (this.kaijuBeamTime > 0 || this.clashActive) {
      if (!this.clashActive) {
        this.kaijuBeamTime += dt
      }
      const p = this.clashActive ? 0.3 : this.kaijuBeamTime / this.kaijuBeamDuration
      if (p >= 1 && !this.clashActive) {
        this.kaijuBeamTime = 0
        this.kaijuBeamGroup.visible = false
      } else {
        this.kaijuBeamGroup.visible = true
        const fade = !this.clashActive && p > 0.72 ? (1 - p) / 0.28 : 1
        const beamEnd = this.clashActive ? clashPoint : heroCenter
        this.kaijuBeamInner.material.uniforms.uTime!.value = elapsed
        this.kaijuBeamInner.material.uniforms.uFade!.value = fade
        this.kaijuBeamOuter.material.uniforms.uTime!.value = elapsed
        this.kaijuBeamOuter.material.uniforms.uFade!.value = fade
        this.alignCylinder(this.kaijuBeamInner, kaijuEmit, beamEnd, 0.44)
        this.alignCylinder(this.kaijuBeamOuter, kaijuEmit, beamEnd, 1.12)
      }
    }

    if (this.clashActive) {
      this.clashGroup.position.copy(clashPoint)
      const jitter = 1.4 + Math.sin(elapsed * 48) * 0.28
      this.clashCore.scale.setScalar(jitter)
      this.clashFlare.material.rotation = elapsed * 14
      this.clashFlare.scale.setScalar(jitter * 5.6)
      if (Math.random() < 0.85) {
        this.spawnBurst(clashPoint, Math.random() > 0.5 ? this.heroBeamColorHex : 0xd946ef, 2, 28, 1.05)
      }
    }

    // 3. 更新抛射物
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i]!
      proj.age += dt
      proj.pos.addScaledVector(proj.vel, dt)
      proj.mesh.position.copy(proj.pos)

      if (proj.kind === 'ultra-disc') {
        proj.mesh.rotation.y += dt * 30
      } else if (proj.kind === 'punch-wave' || proj.kind === 'kick-wave') {
        proj.mesh.scale.addScalar(dt * 3.4)
        if (proj.kind === 'kick-wave') proj.mesh.rotation.z += dt * 18
      } else if (proj.kind === 'palm-bolt') {
        if (Math.random() < 0.55) {
          this.spawnBurst(proj.pos, this.themeBeamColor, 1, 9, 0.48)
        }
      } else if (proj.kind === 'kaiju-fireball') {
        proj.mesh.rotation.x += dt * 8
        proj.mesh.rotation.y += dt * 6
        if (Math.random() < 0.72) {
          this.spawnBurst(proj.pos, 0xff5a1f, 2, 11, 0.72)
        }
      }

      if (proj.hitTriggered || proj.age >= proj.maxAge) {
        this.removeProjectileAt(i)
      }
    }

    // 4. 更新电光拉伸火花条
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const p = this.sparks[i]!
      p.life += dt
      if (p.life >= p.maxLife) {
        this.group.remove(p.mesh)
        ;(p.mesh.material as THREE.Material).dispose()
        this.sparks.splice(i, 1)
        continue
      }
      p.vy -= p.gravity * dt
      p.mesh.position.x += p.vx * dt
      p.mesh.position.y = Math.max(0.08, p.mesh.position.y + p.vy * dt)
      p.mesh.position.z += p.vz * dt

      const speed = Math.hypot(p.vx, p.vy, p.vz)
      const ratio = 1 - p.life / p.maxLife
      if (speed > 0.05) {
        this.tmpDir.set(p.vx / speed, p.vy / speed, p.vz / speed)
        p.mesh.quaternion.setFromUnitVectors(this.upAxis, this.tmpDir)
      }
      const len = Math.max(p.baseWidth, p.baseWidth * p.lengthFactor * (0.4 + speed * 0.045) * ratio)
      p.mesh.scale.set(p.baseWidth * ratio, len, p.baseWidth * ratio)
      ;(p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, ratio * 1.35)
    }

    // 5. 更新刀锋震波细环
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const r = this.shockwaves[i]!
      r.life += dt
      if (r.life >= r.maxLife) {
        this.group.remove(r.mesh)
        r.mesh.material.dispose()
        this.shockwaves.splice(i, 1)
        continue
      }
      const t = r.life / r.maxLife
      const ease = 1 - Math.pow(1 - t, 3)
      if (cameraQuat) r.mesh.quaternion.copy(cameraQuat)
      r.mesh.scale.setScalar(0.35 + ease * r.maxRadius)
      r.mesh.material.uniforms.uProgress!.value = t
    }

    // 6. 更新立体蓝色/金色能量冲击球
    for (let i = this.energySpheres.length - 1; i >= 0; i--) {
      const s = this.energySpheres[i]!
      s.life += dt
      if (s.life >= s.maxLife) {
        this.group.remove(s.mesh)
        s.mesh.material.dispose()
        this.energySpheres.splice(i, 1)
        continue
      }
      const t = s.life / s.maxLife
      const ease = 1 - Math.pow(1 - t, 3)
      s.mesh.scale.setScalar(0.4 + ease * s.maxScale)
      s.mesh.material.uniforms.uProgress!.value = t
    }

    // 7. 更新近战刀光斩击弧
    for (let i = this.slashes.length - 1; i >= 0; i--) {
      const sl = this.slashes[i]!
      sl.life += dt
      if (sl.life >= sl.maxLife) {
        this.group.remove(sl.mesh)
        sl.mesh.material.dispose()
        this.slashes.splice(i, 1)
        continue
      }
      const t = sl.life / sl.maxLife
      sl.mesh.rotation.z += sl.spinZ * dt
      sl.mesh.material.uniforms.uProgress!.value = t
    }

    // 8. 更新十字星芒爆点
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i]!
      f.life += dt
      if (f.life >= f.maxLife) {
        this.group.remove(f.mesh)
        f.mesh.material.dispose()
        this.flares.splice(i, 1)
        continue
      }
      const t = f.life / f.maxLife
      const grow = t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 0.75
      f.mesh.scale.setScalar(Math.max(0.1, grow * f.peakScale))
      f.mesh.material.rotation += dt * f.spinSpeed
      f.mesh.material.opacity = Math.pow(Math.max(1 - t, 0.0001), 1.5)
    }
  }

  public removeProjectileAt(index: number) {
    const proj = this.projectiles[index]
    if (!proj) return
    this.group.remove(proj.mesh)
    proj.mesh.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const m = node as THREE.Mesh
        m.geometry.dispose()
        const mats = Array.isArray(m.material) ? m.material : [m.material]
        for (const mat of mats) mat.dispose()
      } else if ((node as THREE.Sprite).isSprite) {
        ;(node as THREE.Sprite).material.dispose()
      }
    })
    this.projectiles.splice(index, 1)
  }

  public clearAllDynamic() {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      this.removeProjectileAt(i)
    }
    for (const p of this.sparks) {
      this.group.remove(p.mesh)
      ;(p.mesh.material as THREE.Material).dispose()
    }
    this.sparks = []
    for (const r of this.shockwaves) {
      this.group.remove(r.mesh)
      r.mesh.material.dispose()
    }
    this.shockwaves = []
    for (const s of this.energySpheres) {
      this.group.remove(s.mesh)
      s.mesh.material.dispose()
    }
    this.energySpheres = []
    for (const sl of this.slashes) {
      this.group.remove(sl.mesh)
      sl.mesh.material.dispose()
    }
    this.slashes = []
    for (const f of this.flares) {
      this.group.remove(f.mesh)
      f.mesh.material.dispose()
    }
    this.flares = []
    this.heroBeamActive = false
    this.heroBeamGroup.visible = false
    this.kaijuBeamTime = 0
    this.kaijuBeamGroup.visible = false
    this.kaijuChargeSprite.visible = false
    this.clashActive = false
    this.clashGroup.visible = false
    this.shieldMesh.visible = false
    this.rainbowGroup.visible = false
    this.chargeSprite.visible = false
    this.chargeDiscPreview.visible = false
    this.typeChargeSprite.visible = false
    this.warningRing.visible = false
  }

  public dispose() {
    this.clearAllDynamic()
    this.sparkQuadGeo.dispose()
    this.shockwaveGeo.dispose()
    this.sphereBurstGeo.dispose()
    this.slashGeo.dispose()
    this.flareTex.dispose()
    this.sparkTex.dispose()
    this.heroBeamInner.geometry.dispose()
    this.heroBeamInner.material.dispose()
    this.heroBeamOuter.material.dispose()
    for (const f of this.heroBeamFilaments) f.material.dispose()
    for (const l of this.beamLightningLines) {
      l.geometry.dispose()
      ;(l.material as THREE.Material).dispose()
    }
    for (const l of this.impactArcLines) {
      l.geometry.dispose()
      ;(l.material as THREE.Material).dispose()
    }
    this.heroMuzzleSprite.material.dispose()
    this.heroImpactSprite.material.dispose()
    this.kaijuBeamInner.material.dispose()
    this.kaijuBeamOuter.material.dispose()
    this.kaijuChargeSprite.material.dispose()
    this.clashCore.geometry.dispose()
    ;(this.clashCore.material as THREE.Material).dispose()
    this.clashFlare.material.dispose()
    this.shieldMesh.geometry.dispose()
    this.shieldMesh.material.dispose()
    for (const s of this.rainbowStreaks) {
      ;(s.mesh.material as THREE.Material).dispose()
    }
    this.rainbowStreaks[0]?.mesh.geometry.dispose()
    this.rainbowHalo.material.dispose()
    this.chargeSprite.material.dispose()
    this.typeChargeSprite.material.dispose()
    this.warningRing.geometry.dispose()
    this.warningRing.material.dispose()
  }
}
