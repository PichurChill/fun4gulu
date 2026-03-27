<template>
  <div class="system-root">
    <section class="system-section hero-stage">
      <div class="hero-grid">
        <div class="hero-content">
          <div class="mario-badge">SPRITE_ENGINE</div>
          <h1 class="hero-title">PLAY<br/><span class="red-text">ANYWHERE.</span></h1>
          <p class="hero-desc">The intersection of playful soul and high-fidelity engineering.</p>
          <div class="hero-cta">
             <button class="mario-btn-main" @click="scrollToGames">
               <span class="btn-text">EXPLORE ARCHIVE</span>
               <div class="btn-shadow"></div>
             </button>
          </div>
        </div>
        <div class="hero-visual">
          <div class="runner-scene">
             <div class="runner-viewport">
                <div class="scrolling-ground"></div>
                <div class="pixel-cat-runner">
                   <div class="cat-pixel" :style="currentFrameStyle"></div>
                </div>
                <div class="sync-pipe"><div class="pipe-head"></div><div class="pipe-shaft"></div></div>
                <div class="pixel-cloud c1"></div><div class="pixel-cloud c2"></div>
             </div>
             <div class="runner-score">HI 00000 00{{ score }}</div>
          </div>
        </div>
      </div>
      <footer class="hero-footer">
         <div class="f-seg">TYPE: PIXEL_CAT</div>
         <div class="f-seg center">BOX-SHADOW_PIXEL_ART</div>
         <div class="f-seg right">STATUS: LOOPING</div>
      </footer>
    </section>
    <section class="games-stage" id="games-list">
      <div class="stage-inner">
        <div class="title-block"><h2 class="section-label">/ SOFTWARE_LIBRARY</h2><div class="title-line"></div></div>
        <div class="game-grid">
          <router-link v-for="(game, index) in games" :key="game.id" :to="`/game/${game.id}`" class="game-card">
            <div class="card-top"><span class="card-id">#0{{index + 1}}</span><div class="card-status-dot"></div></div>
            <div class="card-main">
               <div class="pixel-art-container"><img :src="getIcon(game.id)" class="game-icon" /></div>
               <h3 class="card-title">{{ t(`message.games.${game.id}.title`).toUpperCase() }}</h3>
               <p class="card-summary">{{ t(`message.games.${game.id}.desc`) }}</p>
            </div>
          </router-link>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const games = [{ id: 'demo1' }, { id: 'demo2' }]
function getIcon(id: string) {
  return id === 'demo1'
    ? 'https://win98icons.alexmeub.com/icons/png/game_solitaire-4.png'
    : 'https://win98icons.alexmeub.com/icons/png/game_freecell-4.png'
}

const mouse = reactive({ x: 0, y: 0 })
const score = ref(0)
const frame = ref(0)
let frameTimer = 0
let scoreTimer = 0

function handleParallax(e: MouseEvent) {
  mouse.x = (e.clientX / window.innerWidth - 0.5) * 2
  mouse.y = (e.clientY / window.innerHeight - 0.5) * 2
}
const getParallax = (s: number) => ({ transform: `translate(${mouse.x * s}px, ${mouse.y * s * 0.5}px)` })

onMounted(() => {
  frameTimer = window.setInterval(() => { frame.value = frame.value === 0 ? 1 : 0 }, 200)
  scoreTimer = window.setInterval(() => { score.value += 1 }, 3000)
})
onUnmounted(() => { clearInterval(frameTimer); clearInterval(scoreTimer) })

function scrollToGames() {
  document.getElementById('games-list')?.scrollIntoView({ behavior: 'smooth' })
}

// 像素绘制引擎 (Pixel Rendering Engine)
const T = '' // transparent
const B = '#000'
const O = '#FF9933' // 橘猫主色
const D = '#CC7A00' // 暗橘色
const P = '#FFB6C1' // 粉色

const PX = 4 // 像素单位大小

// 参考用户提供的 SCSS $cat 数据，1:1 还原结构
// 头部 + 身体（两帧共享）
const sharedRows = [
  [T,T,T,B,T,T,T,T,T,T,B],
  [T,T,B,O,B,T,T,T,T,B,O,B],
  [T,T,B,O,D,B,B,B,B,D,O,B,T,T,T,T,T,T,T,T,B,B],
  [T,B,D,O,O,D,D,O,D,O,O,D,B,T,T,T,T,T,T,B,O,O,B],
  [T,B,O,O,O,O,O,O,O,O,O,O,B,T,T,T,T,T,T,B,O,O,B],
  [B,D,O,O,O,O,O,O,O,O,O,O,D,B,B,B,B,T,T,T,B,D,B],
  [B,O,O,B,O,O,B,O,O,B,O,O,O,D,O,D,O,B,T,T,B,O,B],
  [B,O,P,O,O,B,O,B,O,O,P,O,O,D,O,D,O,O,B,B,B,D,B],
  [B,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,B,O,B],
  [B,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,B,O,B],
  [B,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,B],
  [B,D,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,B],
  [B,D,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,B],
  [B,D,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,D,B],
  [T,B,D,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,D,B],
]

// Frame A 腿部（原始站姿）
const legsA = [
  [T,T,B,D,O,D,D,O,D,O,O,O,D,O,D,D,O,D,B],
  [T,T,T,B,O,B,B,O,B,B,B,B,B,O,B,B,O,B],
  [T,T,T,B,B,T,T,B,B,T,T,T,B,B,T,T,B,B],
]

// Frame B 腿部（行走姿势 - 交替步伐）
const legsB = [
  [T,T,B,D,O,D,D,O,D,O,O,O,D,O,D,D,O,D,B],
  [T,T,B,O,B,B,B,O,B,B,B,B,O,B,B,B,O,B],
  [T,T,B,B,T,T,T,B,B,T,T,T,B,B,T,T,B,B],
]

// 像素翻转引擎：flip=true 时水平镜像，让猫面朝右（奔跑方向）
function pixelize(grid: string[][], flip = false): string {
  const maxCols = Math.max(...grid.map(r => r.length))
  const shadows: string[] = []
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y]
    if (!row) continue
    for (let x = 0; x < row.length; x++) {
      if (row[x] && row[x] !== T) {
        const px = flip ? (maxCols - 1 - x) : x
        shadows.push(`${px * PX}px ${y * PX}px 0 0 ${row[x]}`)
      }
    }
  }
  return shadows.join(',')
}

// flip=true → 猫面朝右
const frameAShadow = pixelize([...sharedRows, ...legsA], true)
const frameBShadow = pixelize([...sharedRows, ...legsB], true)

const currentFrameStyle = computed(() => ({
  boxShadow: frame.value === 0 ? frameAShadow : frameBShadow
}))
</script>

<style scoped>
.system-root { width: 100%; height: auto; background: #FFF; overflow-x: hidden; position: relative; }
.hero-stage { width: 100%; min-height: 100vh; display: flex; flex-direction: column; position: relative; padding: 0 80px; overflow-x: hidden; border-bottom: 4px solid #000; background: transparent; transition: all 0.3s; box-sizing: border-box; }
.hero-grid { flex: 1; display: grid; grid-template-columns: 1fr 1fr; align-items: center; gap: 60px; max-width: 1400px; margin: 0 auto; width: 100%; box-sizing: border-box; padding: 0; }
.hero-visual { position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.runner-scene { width: 500px; height: 260px; position: relative; border-bottom: 6px solid #000; background: transparent; flex-shrink: 0; transform-origin: center; }

/*
 * 碰撞时间窗口精算（Collision Window Calculation）：
 * 猫位置: left=40, 宽92px → x:40~132
 * 水管: left 从 520→-100 (3s)，宽60px(head)
 * 水管右缘到达猫左缘(40): 580-620f=40 → f=87.1%
 * 水管左缘进入猫右缘(132): 520-620f=132 → f=62.6%
 * 危险区间: 62.6% ~ 87.1%
 * 猫必须在此期间完全腾空 (Y < -70px, 水管高70px)
 */
.pixel-cat-runner {
  position: absolute; bottom: 2px; left: 40px; width: 92px; height: 72px; z-index: 50;
  animation: sync-jump 3s linear infinite;
}
@keyframes sync-jump {
  0%   { transform: translateY(0); }
  48%  { transform: translateY(0); }      /* 地面等待 */
  54%  { transform: translateY(-60px); }  /* 起跳加速 */
  60%  { transform: translateY(-110px); } /* 上升中 */
  66%  { transform: translateY(-145px); } /* 接近峰值 */
  72%  { transform: translateY(-155px); } /* 峰值（自然弧顶，非滞空） */
  76%  { transform: translateY(-145px); } /* 开始下坠 */
  80%  { transform: translateY(-125px); } /* 加速下落 */
  84%  { transform: translateY(-100px); } /* 重力加速 */
  87%  { transform: translateY(-80px); }  /* 危险区结束，仍高于水管 */
  91%  { transform: translateY(-40px); }  /* 快速坠落 */
  95%  { transform: translateY(0); }      /* 落地 */
  100% { transform: translateY(0); }
}

.cat-pixel { width: 4px; height: 4px; background: transparent; }

.sync-pipe { position: absolute; bottom: 0; width: 50px; z-index: 30; animation: pipe-scroll 3s linear infinite; }
@keyframes pipe-scroll { 0% { left: 520px; } 100% { left: -100px; } }
.pipe-head { width: 60px; height: 20px; background: var(--mario-yoshi-green); border: 4px solid #000; margin-left: -5px; box-shadow: inset -10px -4px 0 rgba(0,0,0,0.2); }
.pipe-shaft { width: 50px; height: 50px; background: var(--mario-yoshi-green); border-left: 4px solid #000; border-right: 4px solid #000; box-shadow: inset -10px 0 0 rgba(0,0,0,0.2); }
.scrolling-ground { position: absolute; bottom: 0; width: 200%; height: 6px; border-top: 4px dashed #000; animation: ground-scroll 1.5s linear infinite; }
@keyframes ground-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.pixel-cloud { position: absolute; width: 50px; height: 16px; background: #EEE; border: 3px solid #000; border-radius: 8px; opacity: 0.15; }
.c1 { top: 60px; animation: cloud-f 15s linear infinite; }
.c2 { top: 30px; animation: cloud-f 20s linear reverse infinite; }
@keyframes cloud-f { from { left: 110%; } to { left: -20%; } }
.runner-score { position: absolute; top: 20px; right: 20px; font-weight: 900; font-size: 14px; letter-spacing: 2px; }

.hero-title { font-size: 84px; line-height: 0.9; margin: 24px 0; letter-spacing: -4px; transition: font-size 0.3s; }
.red-text { color: var(--mario-red); }
.mario-badge { display: inline-block; background: var(--mario-red); color: #fff; padding: 4px 12px; font-weight: 900; font-size: 12px; border: 3px solid #000; }
.mario-btn-main { position: relative; background: #000; color: #FFF; border: none; padding: 20px 48px; font-size: 16px; font-weight: 900; cursor: pointer; }
.btn-shadow { position: absolute; inset: 0; background: var(--mario-red); transform: translate(8px, 8px); z-index: -1; }
.hero-footer { height: 60px; border-top: 4px solid #000; display: flex; justify-content: space-between; align-items: center; font-size: 10px; font-weight: 800; background: transparent; margin: 0 -80px; padding: 0 80px; transition: all 0.3s; }

.games-stage { padding: 100px 80px; background: #F5F5F3; min-height: 100vh; transition: padding 0.3s; }
.game-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 40px; }
.game-card { background: #FFF; border: 4px solid #000; padding: 40px; text-decoration: none; color: inherit; box-shadow: 12px 12px 0 #000; transition: all 0.3s; }

/* === MOBILE ADAPTIVE LAYERS (HomeView) === */
@media (max-width: 1200px) {
  .hero-stage { padding: 0 40px; }
  .hero-title { font-size: 72px; }
  .game-grid { grid-template-columns: 1fr 1fr; }
}

@media (max-width: 1024px) {
  .hero-stage { height: auto; min-height: 100vh; padding: 0 20px 60px; display: block; overflow-x: hidden; }
  .hero-grid { display: flex; flex-direction: column; padding-top: 120px; gap: 40px; width: 100%; margin: 0; }
  .hero-content { width: 100%; text-align: center; padding: 0; box-sizing: border-box; position: relative; z-index: 10; }
  .hero-visual { width: 100%; height: 240px; order: 2; margin-top: 20px; }
  .hero-title { font-size: 14vw; line-height: 1; margin: 20px 0; }
  .hero-desc { max-width: 100%; padding: 0 10px; font-size: 15px; margin-bottom: 30px; }
  
  .hero-footer { margin: 40px -20px 0; padding: 0 20px; width: calc(100% + 40px); box-sizing: border-box; }
}

@media (max-width: 768px) {
  .hero-title { font-size: 15vw; }
  .hero-visual { height: 200px; }
  .runner-scene { transform: scale(0.65); transform-origin: center; } 
  
  .games-stage { padding: 40px 20px; }
  .game-grid { grid-template-columns: 1fr; gap: 20px; }
}

@media (max-width: 480px) {
  .hero-stage { padding: 0 15px 40px; }
  .hero-title { font-size: 12vw; white-space: nowrap; letter-spacing: -2px; }
  .hero-desc { font-size: 13px; line-height: 1.5; opacity: 0.8; }
  .runner-scene { transform: scale(0.5); } 
  .hero-visual { height: 160px; margin-top: 10px; }
  .hero-cta { width: 100%; padding: 0 10px; box-sizing: border-box; }
  .mario-btn-main { width: 100%; padding: 18px 10px; font-size: 14px; }
  .btn-shadow { transform: translate(5px, 5px); }
  
  .hero-footer { font-size: 8px; height: 50px; }
  .hero-footer .center, .hero-footer .right { display: none; }
}
</style>
