<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const { t } = useI18n()

// ---- 常量 ----
const COLS = 10
const ROWS = 20
const CELL = 24          // 主画布单元格(px)
const PREVIEW_CELL = 16  // 预览画布单元格(px)
const SOFT_DROP_INTERVAL = 45  // 软降间隔(ms)

type PieceId = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L'

// NES 复古调色
const PIECE_COLORS: Record<PieceId, string> = {
  I: '#3FD8E8', O: '#FFD200', T: '#B45CFF', S: '#4FB033',
  Z: '#E63946', J: '#4A90E2', L: '#FF9933',
}

// 方块初始形状（方阵，旋转 = 矩阵顺时针翻转）
const PIECE_MATRIX: Record<PieceId, number[][]> = {
  I: [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  O: [
    [1, 1],
    [1, 1],
  ],
  T: [
    [0, 1, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
    [0, 0, 0],
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
    [0, 0, 0],
  ],
  J: [
    [1, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  L: [
    [0, 0, 1],
    [1, 1, 1],
    [0, 0, 0],
  ],
}

// 墙踢偏移（dx, dy）：原位 → 左1 → 右1 → 上1 → 左2 → 右2（I 型依赖 ±2）
const KICK_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [-1, 0], [1, 0], [0, -1], [-2, 0], [2, 0],
]

// 消行基础分（行数 → 分，× 当前等级）
const LINE_SCORES = [0, 100, 300, 500, 800]

// ---- 状态 ----
const phase = ref<'ready' | 'playing' | 'paused' | 'over'>('ready')
const score = ref(0)
const lines = ref(0)
const level = ref(1)

type Grid = (PieceId | null)[][]
let grid: Grid = createEmptyGrid()

interface ActivePiece {
  id: PieceId
  matrix: number[][]
  x: number
  y: number
}
let current: ActivePiece | null = null
let nextId: PieceId = 'T'
let bag: PieceId[] = []
let softDrop = false

// ---- DOM refs & 画布（非响应式）----
const boardCanvasRef = ref<HTMLCanvasElement | null>(null)
const nextCanvasRef = ref<HTMLCanvasElement | null>(null)
let boardCtx: CanvasRenderingContext2D | null = null
let nextCtx: CanvasRenderingContext2D | null = null

// ---- 音频（方波，复古掌机风格）----
let audioCtx: AudioContext | null = null
function beep(type: OscillatorType, f0: number, f1: number, dur: number, vol = 0.12) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.type = type
    osc.frequency.setValueAtTime(f0, audioCtx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(f1, audioCtx.currentTime + dur)
    gain.gain.setValueAtTime(vol, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + dur)
    osc.start(audioCtx.currentTime)
    osc.stop(audioCtx.currentTime + dur)
  } catch {}
}
function playMoveSound() { beep('square', 320, 320, 0.04, 0.06) }
function playRotateSound() { beep('square', 480, 720, 0.08, 0.1) }
function playLockSound() { beep('square', 220, 160, 0.08, 0.1) }
function playClearSound() { beep('square', 420, 980, 0.25, 0.16) }
function playOverSound() { beep('sawtooth', 300, 55, 0.6, 0.18) }

// ---- 基础操作 ----
function createEmptyGrid(): Grid {
  return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => null))
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = a[i]!
    a[i] = a[j]!
    a[j] = tmp
  }
  return a
}

// 7-bag 随机：洗牌一袋发完再补，避免长时间不出某形状
function drawFromBag(): PieceId {
  if (bag.length === 0) {
    bag = shuffle(Object.keys(PIECE_MATRIX) as PieceId[])
  }
  return bag.pop()!
}

// 矩阵顶部空行数（spawn 时让实心部分贴顶出现）
function topOffset(m: number[][]): number {
  for (let y = 0; y < m.length; y++) {
    if (m[y]!.some(v => v)) return y
  }
  return 0
}

function rotateMatrix(m: number[][]): number[][] {
  const n = m.length
  const res: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      res[y]![x] = m[n - 1 - x]![y]!
    }
  }
  return res
}

function collides(matrix: number[][], px: number, py: number): boolean {
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y]!.length; x++) {
      if (!matrix[y]![x]) continue
      const gx = px + x
      const gy = py + y
      if (gx < 0 || gx >= COLS || gy >= ROWS) return true
      if (gy >= 0 && grid[gy]![gx]) return true
    }
  }
  return false
}

function spawnPiece(id: PieceId): ActivePiece {
  const matrix = PIECE_MATRIX[id].map(r => [...r])
  return { id, matrix, x: Math.floor((COLS - matrix.length) / 2), y: -topOffset(matrix) }
}

// ---- 游戏逻辑 ----
function move(dir: -1 | 1) {
  if (!current || phase.value !== 'playing') return
  if (!collides(current.matrix, current.x + dir, current.y)) {
    current.x += dir
    playMoveSound()
  }
}

function rotate() {
  if (!current || phase.value !== 'playing') return
  if (current.id === 'O') return // O 型旋转无变化
  const rotated = rotateMatrix(current.matrix)
  for (const [dx, dy] of KICK_OFFSETS) {
    if (!collides(rotated, current.x + dx, current.y + dy)) {
      current.matrix = rotated
      current.x += dx
      current.y += dy
      playRotateSound()
      return
    }
  }
}

function stepDown() {
  if (!current) return
  if (!collides(current.matrix, current.x, current.y + 1)) {
    current.y++
  } else {
    lockPiece()
  }
}

function lockPiece() {
  if (!current) return
  let overflow = false
  for (let y = 0; y < current.matrix.length; y++) {
    for (let x = 0; x < current.matrix[y]!.length; x++) {
      if (!current.matrix[y]![x]) continue
      const gy = current.y + y
      if (gy < 0) { overflow = true; continue }
      grid[gy]![current.x + x] = current.id
    }
  }
  if (overflow) {
    current = null
    gameOver()
    return
  }
  playLockSound()

  const cleared = clearLines()
  if (cleared > 0) {
    score.value += LINE_SCORES[cleared]! * level.value
    lines.value += cleared
    level.value = 1 + Math.floor(lines.value / 10)
    playClearSound()
  }

  // 取下一个方块；出生即重叠 → 游戏结束
  const piece = spawnPiece(nextId)
  nextId = drawFromBag()
  drawNext()
  if (collides(piece.matrix, piece.x, piece.y)) {
    gameOver()
    return
  }
  current = piece
}

function clearLines(): number {
  let cleared = 0
  // 删除满行后下方补空行，原 y-1 行会移到 y 位置，索引保持不动才能连续消行
  let y = ROWS - 1
  while (y >= 0) {
    if (grid[y]!.every(c => c)) {
      grid.splice(y, 1)
      grid.unshift(Array.from({ length: COLS }, () => null))
      cleared++
    } else {
      y--
    }
  }
  return cleared
}

// 等级越高下落越快
function dropInterval(): number {
  return Math.max(90, 780 - (level.value - 1) * 65)
}

function gameOver() {
  phase.value = 'over'
  current = null
  softDrop = false
  playOverSound()
}

function startGame() {
  grid = createEmptyGrid()
  bag = []
  score.value = 0
  lines.value = 0
  level.value = 1
  softDrop = false
  current = spawnPiece(drawFromBag())
  nextId = drawFromBag()
  drawNext()
  phase.value = 'playing'
  lastDropTs = performance.now()
}

function togglePause() {
  if (phase.value === 'playing') {
    phase.value = 'paused'
    softDrop = false
  } else if (phase.value === 'paused') {
    phase.value = 'playing'
    lastDropTs = performance.now()
  }
}

function goBack() {
  clearMoveRepeat()
  router.back()
}

// ---- 游戏循环 ----
let animFrameId = 0
let lastDropTs = 0

function loop(ts: number) {
  if (phase.value === 'playing' && current) {
    const interval = softDrop ? SOFT_DROP_INTERVAL : dropInterval()
    if (ts - lastDropTs >= interval) {
      lastDropTs = ts
      stepDown()
    }
  }
  draw()
  animFrameId = requestAnimationFrame(loop)
}

// ---- 键盘（桌面）----
function onKeyDown(e: KeyboardEvent) {
  const k = e.key
  if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowDown' || k === 'ArrowUp' || k === ' ') {
    e.preventDefault()
  }
  if (phase.value === 'ready') {
    if (k === 'Enter' || k === ' ') startGame()
    return
  }
  if (phase.value === 'over') {
    if (k === 'Enter') startGame()
    return
  }
  if (k === 'p' || k === 'P') {
    togglePause()
    return
  }
  if (phase.value !== 'playing') return
  if (k === 'ArrowLeft') move(-1)
  else if (k === 'ArrowRight') move(1)
  else if (k === 'ArrowDown') softDrop = true
  else if (k === 'ArrowUp' && !e.repeat) rotate()
}

function onKeyUp(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') softDrop = false
}

// ---- 触屏按钮 ----
let moveRepeatTimer: number | undefined

function clearMoveRepeat() {
  if (moveRepeatTimer !== undefined) {
    clearInterval(moveRepeatTimer)
    moveRepeatTimer = undefined
  }
}

// 单击移动一格，长按连发
function padMoveStart(dir: -1 | 1) {
  clearMoveRepeat()
  move(dir)
  moveRepeatTimer = window.setInterval(() => move(dir), 140)
}

function padMoveEnd() {
  clearMoveRepeat()
}

function padSoftDropStart() { softDrop = true }
function padSoftDropEnd() { softDrop = false }

// ---- 渲染 ----
function drawCell(ctx: CanvasRenderingContext2D, px: number, py: number, size: number, id: PieceId) {
  ctx.fillStyle = PIECE_COLORS[id]
  ctx.fillRect(px + 1, py + 1, size - 2, size - 2)
  ctx.strokeStyle = '#000'
  ctx.lineWidth = 2
  ctx.strokeRect(px + 2, py + 2, size - 4, size - 4)
  // 像素高光 + 底部暗边
  const hl = Math.max(2, Math.floor(size / 5))
  ctx.fillStyle = 'rgba(255,255,255,0.4)'
  ctx.fillRect(px + 4, py + 4, hl, hl)
  ctx.fillStyle = 'rgba(0,0,0,0.25)'
  ctx.fillRect(px + 3, py + size - 5, size - 6, 2)
}

function draw() {
  const ctx = boardCtx
  if (!ctx) return
  const W = COLS * CELL
  const H = ROWS * CELL
  ctx.fillStyle = '#0d0d1a'
  ctx.fillRect(0, 0, W, H)
  // 网格线
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = 1; x < COLS; x++) {
    ctx.moveTo(x * CELL + 0.5, 0)
    ctx.lineTo(x * CELL + 0.5, H)
  }
  for (let y = 1; y < ROWS; y++) {
    ctx.moveTo(0, y * CELL + 0.5)
    ctx.lineTo(W, y * CELL + 0.5)
  }
  ctx.stroke()
  // 已锁定
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = grid[y]![x]
      if (c) drawCell(ctx, x * CELL, y * CELL, CELL, c)
    }
  }
  // 当前方块
  if (current) {
    for (let y = 0; y < current.matrix.length; y++) {
      for (let x = 0; x < current.matrix[y]!.length; x++) {
        if (!current.matrix[y]![x]) continue
        const gy = current.y + y
        if (gy < 0) continue
        drawCell(ctx, (current.x + x) * CELL, gy * CELL, CELL, current.id)
      }
    }
  }
}

function drawNext() {
  const ctx = nextCtx
  if (!ctx) return
  const S = PREVIEW_CELL * 4
  ctx.fillStyle = '#0d0d1a'
  ctx.fillRect(0, 0, S, S)
  const m = PIECE_MATRIX[nextId]
  // 实心部分 bounding box，居中显示
  let minX = 9, maxX = -1, minY = 9, maxY = -1
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m[y]!.length; x++) {
      if (m[y]![x]) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x)
        minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      }
    }
  }
  const ox = (S - (maxX - minX + 1) * PREVIEW_CELL) / 2 - minX * PREVIEW_CELL
  const oy = (S - (maxY - minY + 1) * PREVIEW_CELL) / 2 - minY * PREVIEW_CELL
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m[y]!.length; x++) {
      if (m[y]![x]) drawCell(ctx, ox + x * PREVIEW_CELL, oy + y * PREVIEW_CELL, PREVIEW_CELL, nextId)
    }
  }
}

// ---- 生命周期 ----
onMounted(() => {
  boardCtx = boardCanvasRef.value?.getContext('2d') ?? null
  nextCtx = nextCanvasRef.value?.getContext('2d') ?? null
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  animFrameId = requestAnimationFrame(loop)
})

onUnmounted(() => {
  cancelAnimationFrame(animFrameId)
  clearMoveRepeat()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
})
</script>

<template>
  <div class="tetris-page">
    <div class="console">
      <!-- 机身顶栏：返回 / 品牌 / 喇叭格栅 -->
      <div class="console-top">
        <button class="mini-btn" @click="goBack">&lt; {{ t('message.tetrisView.back') }}</button>
        <div class="console-brand">FUN4GULU<sup>™</sup></div>
        <div class="speaker"><i></i><i></i><i></i><i></i></div>
      </div>

      <!-- 屏幕总成 -->
      <div class="screen-shell">
        <div class="screen">
          <canvas
            ref="boardCanvasRef"
            class="board-canvas"
            :width="COLS * CELL"
            :height="ROWS * CELL"
          ></canvas>
          <aside class="side-panel">
            <div class="stat">
              <div class="stat-label">{{ t('message.tetrisView.score') }}</div>
              <div class="stat-value">{{ String(score).padStart(6, '0') }}</div>
            </div>
            <div class="stat-row">
              <div class="stat half">
                <div class="stat-label">{{ t('message.tetrisView.level') }}</div>
                <div class="stat-value">{{ level }}</div>
              </div>
              <div class="stat half">
                <div class="stat-label">{{ t('message.tetrisView.lines') }}</div>
                <div class="stat-value">{{ lines }}</div>
              </div>
            </div>
            <div class="stat">
              <div class="stat-label">{{ t('message.tetrisView.next') }}</div>
              <canvas
                ref="nextCanvasRef"
                class="next-canvas"
                :width="PREVIEW_CELL * 4"
                :height="PREVIEW_CELL * 4"
              ></canvas>
            </div>
            <div class="stat grow">
              <div class="stat-label">{{ t('message.tetrisView.item') }}</div>
              <div class="item-slot">{{ t('message.tetrisView.itemEmpty') }}</div>
            </div>
          </aside>
        </div>
        <div class="screen-caption">COLOR TETRIS · 10×20 DOT MATRIX</div>
      </div>

      <!-- 触屏控制区：方向键 + 暂停 + 大旋转键 -->
      <div class="controls">
        <div class="dpad">
          <button
            class="pad-btn"
            aria-label="left"
            @pointerdown.prevent="padMoveStart(-1)"
            @pointerup="padMoveEnd"
            @pointercancel="padMoveEnd"
            @pointerleave="padMoveEnd"
          >◀</button>
          <button
            class="pad-btn"
            aria-label="down"
            @pointerdown.prevent="padSoftDropStart"
            @pointerup="padSoftDropEnd"
            @pointercancel="padSoftDropEnd"
            @pointerleave="padSoftDropEnd"
          >▼</button>
          <button
            class="pad-btn"
            aria-label="right"
            @pointerdown.prevent="padMoveStart(1)"
            @pointerup="padMoveEnd"
            @pointercancel="padMoveEnd"
            @pointerleave="padMoveEnd"
          >▶</button>
        </div>
        <div class="action-group">
          <button class="pause-btn" @click="togglePause">{{ phase === 'paused' ? '▶' : '❚❚' }}</button>
          <button
            class="rotate-btn"
            aria-label="rotate"
            @pointerdown.prevent="rotate"
          >⟳</button>
        </div>
      </div>

      <div class="console-bottom">MODEL GULU-14 · TETRIS SYSTEM</div>
    </div>

    <!-- 开始界面 -->
    <div v-if="phase === 'ready'" class="overlay">
      <div class="start-box">
        <h1>{{ t('message.tetrisView.title') }}</h1>
        <p>{{ t('message.tetrisView.description') }}</p>
        <div class="instructions">{{ t('message.tetrisView.instructions') }}</div>
        <button class="start-btn" @click="startGame">{{ t('message.tetrisView.startButton') }}</button>
      </div>
    </div>

    <!-- 暂停界面 -->
    <div v-else-if="phase === 'paused'" class="overlay dark" @click="togglePause">
      <div class="start-box">
        <h1>{{ t('message.tetrisView.paused') }}</h1>
        <p>{{ t('message.tetrisView.clickToResume') }}</p>
      </div>
    </div>

    <!-- 结束界面 -->
    <div v-else-if="phase === 'over'" class="overlay">
      <div class="start-box">
        <h1>{{ t('message.tetrisView.gameOver') }}</h1>
        <p>{{ t('message.tetrisView.finalScore') }}: {{ score }}</p>
        <button class="start-btn" @click="startGame">{{ t('message.tetrisView.restartButton') }}</button>
        <div>
          <button class="mini-btn sub-btn" @click="goBack">&lt; {{ t('message.tetrisView.back') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tetris-page {
  min-height: 100vh;
  padding: 96px 16px 28px;
  display: flex;
  justify-content: center;
  background: #EBEBEB;
}

/* 黄色掌机机身 */
.console {
  width: min(432px, 100%);
  background: #FFC53D;
  border: 5px solid #000;
  border-radius: 20px 20px 44px 20px;
  box-shadow: 10px 10px 0 rgba(0, 0, 0, 0.9);
  padding: 14px 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-sizing: border-box;
}

.console-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mini-btn {
  background: #000;
  color: #FFC53D;
  border: none;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 1px;
  cursor: pointer;
  box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.35);
}

.mini-btn:active {
  transform: translate(2px, 2px);
  box-shadow: 1px 1px 0 rgba(0, 0, 0, 0.35);
}

.console-brand {
  font-size: 14px;
  font-weight: 950;
  letter-spacing: 1px;
  color: #7a4c00;
}

.speaker {
  display: flex;
  gap: 5px;
}

.speaker i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #b98a00;
  box-shadow: inset 1px 1px 2px rgba(0, 0, 0, 0.45);
}

/* 屏幕 */
.screen-shell {
  background: #1b1b26;
  border: 4px solid #000;
  border-radius: 10px;
  padding: 10px;
  box-shadow: inset 0 0 0 3px #33334a;
}

.screen {
  display: flex;
  gap: 10px;
  justify-content: center;
  align-items: stretch;
}

.board-canvas {
  height: min(46vh, 480px);
  aspect-ratio: 1 / 2;
  image-rendering: pixelated;
  border: 3px solid #33334a;
  background: #0d0d1a;
}

.side-panel {
  width: 116px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.stat {
  background: #101020;
  border: 2px solid #33334a;
  padding: 6px 8px;
  font-family: 'DotGothic16', monospace;
}

.stat.half {
  flex: 1;
}

.stat.grow {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.stat-row {
  display: flex;
  gap: 8px;
}

.stat-label {
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 1px;
  color: #8a8ab0;
  margin-bottom: 3px;
}

.stat-value {
  font-size: 15px;
  font-weight: 900;
  color: #fff;
}

.next-canvas {
  display: block;
  image-rendering: pixelated;
  margin: 2px auto 0;
  border: 2px solid #33334a;
}

.item-slot {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed #33334a;
  color: #55557a;
  font-size: 11px;
  min-height: 34px;
}

.screen-caption {
  text-align: center;
  color: #8a8ab0;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 2px;
  margin-top: 8px;
  font-family: 'DotGothic16', monospace;
}

/* 触屏控制区 */
.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 6px;
}

.dpad {
  display: flex;
  gap: 10px;
}

.pad-btn {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #23232e;
  color: #fff;
  font-size: 18px;
  border: 4px solid #000;
  box-shadow: 0 5px 0 #000;
  cursor: pointer;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  padding: 0;
}

.pad-btn:active {
  transform: translateY(4px);
  box-shadow: 0 1px 0 #000;
}

.action-group {
  display: flex;
  align-items: center;
  gap: 16px;
}

.pause-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #4a4a58;
  color: #fff;
  font-size: 13px;
  border: 4px solid #000;
  box-shadow: 0 4px 0 #000;
  cursor: pointer;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  padding: 0;
}

.pause-btn:active {
  transform: translateY(3px);
  box-shadow: 0 1px 0 #000;
}

.rotate-btn {
  width: 88px;
  height: 88px;
  border-radius: 50%;
  background: #E63946;
  color: #fff;
  font-size: 36px;
  font-weight: 900;
  border: 5px solid #000;
  box-shadow: 0 7px 0 #000;
  cursor: pointer;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  padding: 0;
  line-height: 1;
}

.rotate-btn:active {
  transform: translateY(5px);
  box-shadow: 0 2px 0 #000;
}

.console-bottom {
  text-align: center;
  color: #7a4c00;
  font-size: 9px;
  font-weight: 900;
  letter-spacing: 2px;
}

/* 覆盖层（开始 / 暂停 / 结束） */
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(235, 235, 235, 0.96);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.overlay.dark {
  background: rgba(13, 13, 26, 0.82);
  cursor: pointer;
}

.start-box {
  text-align: center;
  color: #000;
  max-width: 420px;
}

.start-box h1 {
  font-size: 52px;
  font-weight: 950;
  margin-bottom: 12px;
}

.start-box p {
  font-size: 15px;
  font-weight: 700;
  color: #555;
  margin-bottom: 18px;
}

.instructions {
  background: #fff;
  border: 3px solid #000;
  box-shadow: 5px 5px 0 #000;
  padding: 12px 16px;
  font-size: 13px;
  font-weight: 800;
  margin-bottom: 26px;
  line-height: 1.8;
}

.start-btn {
  background: #000;
  color: #fff;
  border: none;
  padding: 18px 48px;
  font-size: 20px;
  font-weight: 900;
  letter-spacing: 2px;
  cursor: pointer;
  box-shadow: 6px 6px 0 #000;
  position: relative;
  transition: transform 0.2s;
}

.start-btn::after {
  content: '';
  position: absolute;
  inset: 0;
  background: #E63946;
  transform: translate(6px, 6px);
  z-index: -1;
}

.start-btn:hover {
  transform: translate(2px, 2px);
  box-shadow: 4px 4px 0 #000;
}

.sub-btn {
  margin-top: 18px;
}

/* 移动端适配 */
@media (max-width: 480px) {
  .tetris-page {
    padding: 92px 10px 16px;
  }

  .console {
    padding: 12px 12px 18px;
    gap: 12px;
  }

  .board-canvas {
    height: min(42vh, 460px);
  }

  .side-panel {
    width: 104px;
  }

  .pad-btn {
    width: 50px;
    height: 50px;
    font-size: 16px;
  }

  .rotate-btn {
    width: 78px;
    height: 78px;
    font-size: 32px;
  }

  .start-box h1 {
    font-size: 36px;
  }

  .instructions {
    font-size: 12px;
  }
}
</style>
