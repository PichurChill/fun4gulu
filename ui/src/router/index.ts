import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import GameView from '../views/GameView.vue'
import JumpCatView from '../views/JumpCatView.vue'
import HurdleCatView from '../views/HurdleCatView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView
    },
    {
      path: '/game/:id',
      name: 'game',
      component: GameView
    },
    {
      path: '/jump-cat',
      name: 'jump-cat',
      component: JumpCatView
    },
    {
      path: '/hurdle-cat',
      name: 'hurdle-cat',
      component: HurdleCatView
    }
  ]
})

export default router
