import './src/polyfills';
// Defines the reply-alert background task at module scope, before the app
// registers (expo-task-manager requirement; a no-op on builds without it).
import './src/lib/replyTask';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
