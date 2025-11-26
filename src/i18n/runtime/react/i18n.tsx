'use client';

import React, { createContext, useEffect, useState, ReactNode } from 'react';

type Messages = Record<string, string>;
type MessagesByLocale = Record<string, Messages>;

type I18nContextValue = {
  locale: string;
  t: (key: string) => string;
};

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

let currentLocale = 'en';
let currentMessagesByLocale: MessagesByLocale = {};
const listeners: ((locale: string) => void)[] = [];

type I18nProviderProps = {
  initialLocale: string;
  messagesByLocale: MessagesByLocale;
  children: ReactNode;
};

export function I18nProvider(props: I18nProviderProps) {
  const [locale, setLocaleState] = useState(props.initialLocale);

  useEffect(() => {
    currentMessagesByLocale = props.messagesByLocale;
    currentLocale = props.initialLocale;
  }, [props.messagesByLocale, props.initialLocale]);

  useEffect(() => {
    const listener = (nextLocale: string) => {
      setLocaleState(nextLocale);
    };
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    };
  }, []);

  useEffect(() => {
    currentLocale = locale;
  }, [locale]);

  const translate = (key: string) => {
    const messages = currentMessagesByLocale[locale] || {};
    const value = messages[key];
    if (typeof value === 'string') {
      return value;
    }
    return key;
  };

  const value: I18nContextValue = {
    locale,
    t: translate,
  };

  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

export function t(key: string): string {
  const messages = currentMessagesByLocale[currentLocale] || {};
  const value = messages[key];
  if (typeof value === 'string') {
    return value;
  }
  return key;
}

export function setLocale(locale: string): void {
  currentLocale = locale;
  const copy = listeners.slice();
  for (const listener of copy) {
    listener(locale);
  }
}

export function getLocale(): string {
  return currentLocale;
}

export { I18nContext, type Messages, type MessagesByLocale, type I18nContextValue };
