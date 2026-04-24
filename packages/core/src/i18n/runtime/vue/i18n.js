import { ref } from 'vue';

const currentLocale = ref('en');
const store = {};

export function initI18n(initialLocale, messagesByLocale) {
  currentLocale.value = initialLocale || 'en';
  for (const k of Object.keys(messagesByLocale || {})) {
    store[k] = { ...messagesByLocale[k] };
  }
}

export function t(key) {
  const messages = store[currentLocale.value] || {};
  const value = messages[key];
  if (typeof value === 'string') return value;
  return key;
}

export function setLocale(locale) {
  currentLocale.value = locale;
}

export function getLocale() {
  return currentLocale.value;
}

export { currentLocale };
