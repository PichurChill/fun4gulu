<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()

function changeLocale(newLocale: string) {
  locale.value = newLocale
}
</script>

<template>
  <div class="famicom-layout">
    <!-- Header -->
    <header class="nes-container is-dark with-title top-header">
      <p class="title"><i class="nes-icon coin is-small"></i> FUN4GULU</p>
      <div class="header-nav">
        <router-link to="/">
          <button type="button" class="nes-btn is-error">{{ t('message.home') }}</button>
        </router-link>
        <div class="lang-select">
          <div class="nes-select is-error lang-dropdown">
            <select v-model="locale">
              <option value="zh">中</option>
              <option value="en">EN</option>
              <option value="ja">日</option>
              <option value="ko">한</option>
              <option value="fr">FR</option>
            </select>
          </div>
        </div>
      </div>
    </header>

    <!-- Main Content -->
    <main class="main-content">
      <router-view />
    </main>

    <!-- Footer -->
    <footer class="footer">
      <p>© 2026 Fun4Gulu - 8-Bit Web Games</p>
    </footer>
  </div>
</template>

<style>
/* Global Famicom Style Overrides */
:root {
  --fc-red: #E60012;
  --fc-white: #F8F8F8;
  --fc-gold: #FFD700;
}

html, body {
  margin: 0;
  padding: 0;
  background-color: var(--fc-white);
  font-family: 'Press Start 2P', 'DotGothic16', monospace, sans-serif;
  color: #212529;
}

/* NES overrides for FC colors */
.nes-btn.is-error {
  background-color: var(--fc-red) !important;
}

.nes-select.is-error select {
  font-family: 'DotGothic16', monospace; /* for language options */
}

.famicom-layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.top-header {
  border-radius: 0 !important;
  background-color: #212529 !important; /* Dark header contrast */
  display: flex !important;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  padding: 1.5rem 2rem !important;
  margin-bottom: 2rem !important;
  box-sizing: border-box;
}

.top-header .title {
  font-size: 1.2rem;
  margin: 0 !important;
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-nav {
  display: flex;
  gap: 15px;
  align-items: center;
}

.lang-dropdown {
  width: 90px;
  margin-bottom: 0 !important;
}

.main-content {
  flex: 1;
  max-width: 1000px;
  margin: 0 auto;
  padding: 0 1rem;
  width: 100%;
  box-sizing: border-box;
}

.footer {
  text-align: center;
  padding: 2rem;
  background-color: var(--fc-red);
  color: white;
  margin-top: 4rem; /* push to bottom */
  border-top: 4px solid #000;
  font-size: 0.8rem;
}

p, a, button, h1, h2, h3, span {
  font-family: 'Press Start 2P', 'DotGothic16', monospace;
}

a {
  text-decoration: none;
}
</style>
