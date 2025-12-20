import React, { useEffect, useRef, useState } from 'react';
import { setLocale } from '@/i18n';
import { useTranslation } from '@/hooks/useTranslation';

const GlobeIcon = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <ellipse cx="12" cy="12" rx="4" ry="9" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" strokeWidth="1.4" />
    <path
      d="M12 2.5c-2.2 2-3.5 5.4-3.5 9.5 0 4.1 1.3 7.5 3.5 9.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <path
      d="M12 2.5c2.2 2 3.5 5.4 3.5 9.5 0 4.1-1.3 7.5-3.5 9.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    />
  </svg>
);

const CheckIcon = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M5 13.5l4 4 10-10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function LanguageSwitcher({
  iconClassName = 'w-5 h-5',
  badgeClassName = 'text-[10px]',
  menuItemClassName = 'text-sm',
  align = 'right',
}) {
  const { t, locale } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onClick = (e) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target)) {
        setOpen(false);
      }
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, []);

  const handleSet = (lng) => {
    setOpen(false);
    setLocale(lng);
  };

  const badgeKey = t(`LanguageSwitcher.text.${locale}`);
  const badgeText = badgeKey === `LanguageSwitcher.text.${locale}` ? String(locale || '').toUpperCase() : badgeKey;

  const languages = [
    { code: 'en', flag: '🇺🇸', label: t('LanguageSwitcher.text.english'), nativeLabel: 'English' },
    { code: 'fr', flag: '🇫🇷', label: t('LanguageSwitcher.text.francais'), nativeLabel: 'Français' },
  ];

  return (
    <div ref={ref} className="relative inline-flex items-center">
      <button
        type="button"
        aria-label={t('LanguageSwitcher.aria_label.change_language')}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`
          relative inline-flex items-center justify-center
          h-10 w-10 rounded-lg
          bg-slate-50 hover:bg-slate-100
          border border-slate-200 hover:border-slate-300
          transition-all duration-200
          ${open ? 'bg-slate-100 border-slate-300 shadow-sm' : ''}
        `}
      >
        <GlobeIcon className={`${iconClassName} text-slate-600 transition-colors`} />

        <span
          className={`
            absolute -top-1 -right-1
            min-w-[22px] h-[18px]
            flex items-center justify-center
            px-1.5 rounded-md
            bg-slate-700 text-white
            border border-slate-600
            font-medium tracking-wide
            shadow-sm
            transition-all duration-200
            ${badgeClassName}
            ${open ? 'scale-100 opacity-100' : 'scale-90 opacity-90'}
          `}
          style={{ fontSize: '9px', lineHeight: 1 }}
        >
          {badgeText}
        </span>
      </button>

      {open && (
        <div
          className={`
            absolute top-12 min-w-[220px]
            bg-white rounded-lg
            border border-slate-200
            shadow-xl
            overflow-hidden
            z-50
            animate-in fade-in slide-in-from-top-2 duration-200
            ${align === 'right' ? 'right-0' : 'left-0'}
          `}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              {t('LanguageSwitcher.text.select_language')}
            </p>
          </div>

          <div className="py-1">
            {languages.map((lang) => (
              <button
                key={lang.code}
                type="button"
                onClick={() => handleSet(lang.code)}
                className={`
                  flex w-full items-center gap-3 px-4 py-2.5
                  transition-colors duration-150
                  ${
                    locale === lang.code
                      ? 'bg-slate-50 text-slate-900'
                      : 'text-slate-700 hover:bg-slate-50'
                  }
                  ${menuItemClassName}
                `}
              >
                <span className="text-lg leading-none">{lang.flag}</span>

                <div className="flex-1 text-left">
                  <div className="font-medium">{lang.nativeLabel}</div>
                  <div className="text-xs text-slate-500">{lang.label}</div>
                </div>

                {locale === lang.code && <CheckIcon className="w-4 h-4 text-slate-600" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default LanguageSwitcher;
