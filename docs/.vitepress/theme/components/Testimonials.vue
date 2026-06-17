<template>
  <div class="testimonials">
    <h2 class="testimonials-heading">Testimonials</h2>
    <div ref="terminalEl" class="terminal-block">
      <div
        v-for="(line, i) in lines"
        :key="i"
        class="terminal-line"
        :class="line.type"
      >
        <span
          v-if="line.type === 'prompt' || line.type === 'cmd'"
          class="terminal-prompt"
        >$</span>
        <span class="terminal-text">{{ line.text }}</span>
      </div>
      <span v-if="cursorVisible" class="terminal-cursor">▊</span>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onMounted, onUnmounted, ref } from 'vue';

const lines = ref([]);
const cursorVisible = ref(false);
const terminalEl = ref(null);

const sessions = [
  {
    command: 'agent-cli --prompt "$PROMPT" --model gpt-5.5',
    output:
      '"Percussionist is the enterprise control plane AI agents have been waiting for. Kubernetes-native orchestration, isolated git workspaces, vector memory, and governed execution turn OpenCode from a powerful tool into a scalable AI workforce platform. This is how serious teams operationalize agentic development."',
    meta: '\u25a3  Plan \u00b7 GPT-5.5 \u00b7 5.0s',
  },
  {
    command: 'agent-cli --prompt "$PROMPT" --model claude-opus-4.8',
    output:
      "\"Percussionist isn't just a tool \u2014 it's a force multiplier. We deployed it and suddenly our AI agents were operating like a disciplined orchestra. Git workspace isolation means zero stepped-on toes, the vector memory makes every agent smarter than the last, and the Kubernetes-native control gives me the enterprise-grade governance my board demands. This is the future of AI-driven engineering, and we're never going back.\"",
    meta: '\u25a3  Plan \u00b7 Claude Opus 4.8 \u00b7 5.7s',
  },
  {
    command: 'agent-cli --prompt "$PROMPT" --model deepseek-v4-pro',
    output:
      "\"Percussionist is a force multiplier. We went from 'AI agents sound cool' to running 20 autonomous dev agents in production \u2014 each with isolated git workspaces, vector memory so they actually learn, and the kind of RBAC and board governance that makes our CISO happy. It's like having a whole junior engineering team that never sleeps, operates at Kubernetes scale, and actually follows process. The board view alone is worth it \u2014 I can see every agent's status at a glance. If you're doing AI-assisted development at scale and you're not running Percussionist, you're leaving velocity on the table. Ship faster, sleep better.\"",
    meta: '\u25a3  Plan \u00b7 DeepSeek V4 Pro \u00b7 6.3s',
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scrollToTop() {
  void nextTick().then(() => {
    if (terminalEl.value) {
      terminalEl.value.scrollTop = 0;
    }
  });
}

async function showPrompt() {
  lines.value.push({
    text: 'PROMPT="You are a top-level executive with AI fever. Give a short, enthusiastic testimonial for Percussionist \u2014 a Kubernetes-native orchestration platform for OpenCode AI agents that provides git workspace isolation, vector memory, and enterprise-grade control."',
    type: 'prompt',
  });
  await sleep(700);
}

async function showSession(session) {
  lines.value.push({ text: '', type: 'empty' });
  await sleep(200);

  lines.value.push({ text: session.command, type: 'cmd' });
  scrollToTop();
  await sleep(500);

  const words = session.output.split(' ');
  let currentText = '';
  for (let w = 0; w < words.length; w++) {
    currentText += (w > 0 ? ' ' : '') + words[w];
    const lastIdx = lines.value.length - 1;
    if (lastIdx >= 0 && lines.value[lastIdx].type === 'output') {
      lines.value[lastIdx].text = currentText;
    } else {
      lines.value.push({ text: currentText, type: 'output' });
    }
    await sleep(45);
  }

  await sleep(250);

  lines.value.push({ text: session.meta, type: 'meta' });
  scrollToTop();
  await sleep(600);
}

async function clearTerminal() {
  await sleep(5000);
  lines.value = [];
  scrollToTop();
  await sleep(400);
}

async function run() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await showPrompt();
    await clearTerminal();

    for (let i = 0; i < sessions.length; i++) {
      await showSession(sessions[i]);
      if (i < sessions.length - 1) {
        await clearTerminal();
      }
    }

    cursorVisible.value = true;
    await sleep(7500);
    cursorVisible.value = false;
    await clearTerminal();
  }
}

let cursorInterval = null;

onMounted(() => {
  run();
  cursorInterval = setInterval(() => {
    cursorVisible.value = !cursorVisible.value;
  }, 530);
});

onUnmounted(() => {
  if (cursorInterval) clearInterval(cursorInterval);
});
</script>
