<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const games = [
  { id: 'demo1', img: 'https://placehold.co/400x300/E60012/FFFFFF/png?text=Demo+1' },
  { id: 'demo2', img: 'https://placehold.co/400x300/000000/FFFFFF/png?text=Demo+2' }
]
</script>

<template>
  <div class="home-container">
    <!-- Hero Section -->
    <section class="hero nes-container is-rounded is-dark">
      <div class="hero-content">
        <h1><i class="nes-icon trophy is-large" style="margin-right: 20px;"></i>{{ t('message.welcome') }}</h1>
        <p class="blink-text">{{ t('message.nav_games') }}</p>
      </div>
    </section>

    <!-- Game List Section -->
    <section class="game-list-section">
      <h2 class="title" style="color: var(--fc-red); margin-bottom: 30px; text-align: center;">
        {{ t('message.games_list') }}
      </h2>
      <div class="games-grid">
        <router-link v-for="game in games" :key="game.id" :to="`/game/${game.id}`" class="game-card nes-container is-rounded with-title">
          <p class="title">{{ t(`message.games.${game.id}.title`) }}</p>
          <img :src="game.img" class="game-img" alt="game preview"/>
          <p class="game-desc">{{ t(`message.games.${game.id}.desc`) }}</p>
          <button class="nes-btn is-success">{{ t('message.play') }}</button>
        </router-link>
      </div>
      <div class="coming-soon nes-container is-dark">
        <p>{{ t('message.coming_soon') }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.hero {
  min-height: 80vh;
  display: flex !important;
  align-items: center;
  justify-content: center;
  text-align: center;
  margin-bottom: 4rem;
  background-color: #212529 !important;
  border-width: 4px;
}

.hero-content h1 {
  font-size: 1.8rem;
  line-height: 1.8;
  margin-bottom: 2rem;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}

.blink-text {
  animation: blinker 1.5s linear infinite;
  color: #FFD700;
  font-size: 1.2rem;
}

@keyframes blinker {
  50% { opacity: 0; }
}

.games-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 2rem;
}

.game-card {
  display: flex !important;
  flex-direction: column;
  align-items: center;
  transition: transform 0.2s;
  cursor: pointer;
  background-color: #fff !important;
  text-decoration: none;
  color: inherit;
  border-width: 4px;
}

.game-card:hover {
  transform: translateY(-5px);
  box-shadow: 0 5px 0 #000;
}

.game-img {
  width: 100%;
  height: auto;
  image-rendering: pixelated;
  margin-bottom: 1.5rem;
  border: 4px solid #000;
}

.game-desc {
  font-size: 0.8rem;
  margin-bottom: 1.5rem;
  text-align: center;
  height: 2.5rem;
}

.coming-soon {
  text-align: center;
  margin-top: 4rem;
  border-width: 4px;
}
</style>
