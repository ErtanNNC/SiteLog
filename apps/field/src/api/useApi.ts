import { useContext } from 'react';
import type { FieldRoutes } from './field';
import { ApiContext } from './context';

export function useApi(): FieldRoutes {
  return useContext(ApiContext);
}
