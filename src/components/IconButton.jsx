import Icon from './Icon.jsx';

export default function IconButton({ name, onClick, size = 22, className = '', label }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`btn-press flex items-center justify-center rounded-full bg-white/10 active:bg-white/20 ${className}`}
      style={{ width: size + 26, height: size + 26 }}
    >
      <Icon name={name} size={size} />
    </button>
  );
}
