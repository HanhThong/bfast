import { createRoot } from 'react-dom/client';
import { ScanApp } from './components/scanApp';
import './style.css';

const container = document.getElementById('root');
if (container) {
	createRoot(container).render(<ScanApp />);
}
