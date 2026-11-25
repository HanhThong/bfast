import { createRoot } from 'react-dom/client';
import { GenerateApp } from './components/generateApp';
import './style.css';

const container = document.getElementById('root');
if (container) {
	createRoot(container).render(<GenerateApp />);
}
