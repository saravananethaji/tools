import { createRoot } from 'react-dom/client';
import './styles.css';
import './entry-point.css';
import { App } from './App';

const host = document.getElementById('root');
if (host) createRoot(host).render(<App />);
