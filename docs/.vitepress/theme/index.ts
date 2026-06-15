import DefaultTheme from 'vitepress/theme';
import Testimonials from './components/Testimonials.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Testimonials', Testimonials);
  },
};
