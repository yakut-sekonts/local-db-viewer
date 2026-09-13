import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode; resetKey?: string; retry?: boolean }
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: Props) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="boundary-error" role="alert"><strong>Не удалось показать эту часть интерфейса.</strong><p>Проверьте настройки подключения. Сохранённые SQL и профили не удалены.</p>{this.props.retry
      ? <button className="button secondary" onClick={() => this.setState({ failed: false })}>Повторить отображение</button>
      : <p>Закройте и снова откройте Local DB Viewer. При закрытии приложение завершит активные сессии.</p>}</div>;
  }
}
