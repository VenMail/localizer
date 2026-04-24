'use client';

import { useContext } from 'react';
import { I18nContext, t, setLocale, getLocale } from '../i18n';

export function useTranslation() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    return {
      t,
      locale: getLocale(),
      setLocale,
    };
  }
  return {
    t: ctx.t,
    locale: ctx.locale,
    setLocale,
  };
}
