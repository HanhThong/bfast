import { createRoot } from 'react-dom/client';
import { SettingsForm } from './components/settingsForm';
import './style.css';

const container = document.getElementById('root');
if (container) {
	createRoot(container).render(<SettingsForm />);
}
