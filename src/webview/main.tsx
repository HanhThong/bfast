import { createRoot } from 'react-dom/client';
import { App } from './app';
import './style.css';

const container = document.getElementById('root');
if (container) {
	createRoot(container).render(<App />);
}
