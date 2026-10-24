import { createContext } from 'react';
import { fieldRoutes, type FieldRoutes } from './field';

/** The field-api routes the screens call (`ApiProvider`, `useApi`); the app's own by default. */
export const ApiContext = createContext<FieldRoutes>(fieldRoutes);
