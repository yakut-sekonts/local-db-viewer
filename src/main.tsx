import React from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './ErrorBoundary';
import { App } from './App';
import { NetworkProvider } from './NetworkCenter';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><NetworkProvider><App /></NetworkProvider></ErrorBoundary></React.StrictMode>);
