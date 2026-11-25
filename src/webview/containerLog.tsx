import { createRoot } from 'react-dom/client';
import { ContainerLogApp } from './components/containerLogApp';
import './style.css';

const container = document.getElementById('root');
if (container) {
	createRoot(container).render(<ContainerLogApp />);
}
