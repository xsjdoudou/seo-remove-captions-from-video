import type { EraseMode } from '../lib/api'
import { SparkIcon, FrameIcon } from './icons'

/**
 * 左边那列的模式选择。
 *
 * 放在画布左侧、和画布平齐：这是"动手之前先定一件事"的位置——
 * 读的顺序正好是「用哪种方式 → 把片子放进来」。塞进画布上方会把拖放框
 * 往下推，而拖放框是来这个站的人第一个要找的东西。
 *
 * 两个选项都写了一句话解释:自动和框选的区别不是功能多少,而是
 * "让它自己找"还是"我来指"。不说清楚的话,用户只会按名字猜,
 * 猜错了就是一次白跑的处理。
 */
export default function ModePicker({
  mode,
  onChange,
  disabled = false,
}: {
  mode: EraseMode
  onChange: (mode: EraseMode) => void
  disabled?: boolean
}) {
  return (
    <aside className="modes" aria-label="Removal mode">
      <h2 className="modes__title">Removal mode</h2>

      {/* radiogroup 而不是两个 button：键盘上用方向键就能切,
          读屏软件也会把它读成"二选一",而不是两个各自孤立的按钮。 */}
      <div className="modes__list" role="radiogroup" aria-label="Removal mode">
        <Option
          mode="auto"
          current={mode}
          onChange={onChange}
          disabled={disabled}
          icon={<SparkIcon className="modes__icon" />}
          title="Auto"
          text="Finds the subtitles for you."
        />
        <Option
          mode="box"
          current={mode}
          onChange={onChange}
          disabled={disabled}
          icon={<FrameIcon className="modes__icon" />}
          title="Box select"
          text="Draw over what to erase. Best when the text sits outside the usual caption area."
        />
      </div>

      <p className="modes__note">
        {mode === 'auto'
          ? 'Auto looks for caption text across the frame. If it misses something, switch to box select.'
          : 'You will draw the boxes on the first frame after picking a video. Everything inside them is erased for the whole clip.'}
      </p>
    </aside>
  )
}

function Option({
  mode,
  current,
  onChange,
  disabled,
  icon,
  title,
  text,
}: {
  mode: EraseMode
  current: EraseMode
  onChange: (mode: EraseMode) => void
  disabled: boolean
  icon: React.ReactNode
  title: string
  text: string
}) {
  const active = current === mode
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={`mode${active ? ' mode--active' : ''}`}
      onClick={() => onChange(mode)}
      disabled={disabled}
      // 处理中不让切：此刻切换改不了已经提交出去的那个任务，
      // 只会让界面显示的模式和正在跑的任务对不上。
      title={disabled ? 'Finish or cancel the current video first' : undefined}
    >
      {icon}
      <span className="mode__body">
        <span className="mode__title">{title}</span>
        <span className="mode__text">{text}</span>
      </span>
    </button>
  )
}
