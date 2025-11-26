'use client';

import React, { createContext, useEffect, useState } from 'react';

const I18nContext = createContext(null);

let currentLocale = 'en';
let currentMessagesByLocale = {};
const listeners = [];

export function I18nProvider({ initialLocale, messagesByLocale, children }) {
  const [locale, setLocaleState] = useState(initialLocale);

  useEffect(() => {
    currentMessagesByLocale = messagesByLocale || {};
    currentLocale = initialLocale || 'en';
  }, [messagesByLocale, initialLocale]);

  useEffect(() => {
    const listener = (nextLocale) => {
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

  const translate = (key) => {
    const messages = currentMessagesByLocale[locale] || {};
    const value = messages[key];
    if (typeof value === 'string') {
      return value;
    }
    return key;
  };

  const value = {
    locale,
    t: translate,
  };

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function t(key) {
  const messages = currentMessagesByLocale[currentLocale] || {};
  const value = messages[key];
  if (typeof value === 'string') {
    return value;
  }
  return key;
}

export function setLocale(locale) {
  currentLocale = locale;
  const copy = listeners.slice();
  for (const listener of copy) {
    listener(locale);
  }
}

export function getLocale() {
  return currentLocale;
}

export { I18nContext };
