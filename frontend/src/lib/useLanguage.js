import { useContext } from 'react';
import { LanguageContext } from './language-context';

export function useLanguage() {
  return useContext(LanguageContext);
}