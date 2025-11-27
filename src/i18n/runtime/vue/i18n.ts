import { ref } from 'vue';

export type Messages = Record<string, string>;
export type MessagesByLocale = Record<string, Messages>;

export const currentLocale = ref<string>('en');
const store: MessagesByLocale = {};

export function initI18n(initialLocale: string, messagesByLocale: MessagesByLocale): void {
  currentLocale.value = initialLocale || 'en';
  for (const k of Object.keys(messagesByLocale || {})) {
    store[k] = { ...(messagesByLocale as any)[k] };
  }
}

export function t(key: string): string {
  const messages = store[currentLocale.value] || {};
  const value = messages[key];
  if (typeof value === 'string') return value;
  return key;
}

export function setLocale(locale: string): void {
  currentLocale.value = locale;
}

export function getLocale(): string {
  return currentLocale.value;
}
