import { useState } from 'react';
import { useLeadsContext } from '../context/LeadsContext';
import LeadCard from './LeadCard';

export default function KanbanColumn({ col, leads, isSelected, onSelect }) {
  const { changeStatus, readOnly } = useLeadsContext();
  const [dragOver, setDragOver] = useState(false);
  const [bgC, textC] = col.cnt.split('/');

  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  }

  function handleDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const id = e.dataTransfer.getData('text/plain');
    if (id && !readOnly) changeStatus(id, col.id);
  }

  return (
    <div
      className={`col${isSelected ? ' col-selected' : ''}${dragOver ? ' drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="col-hdr" onClick={onSelect} title="Click to view lead list">
        <div className="col-dot" style={{ background: col.dot }}></div>
        <span className="col-lbl">{col.label}</span>
        <span className="col-cnt" style={{ background: bgC, color: textC }}>{leads.length}</span>
        <svg className="col-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="5" r="1"/>
          <circle cx="12" cy="12" r="1"/>
          <circle cx="12" cy="19" r="1"/>
        </svg>
      </div>
      <div className="col-cards">
        {leads.map(lead => (
          <LeadCard key={lead.id} lead={lead} />
        ))}
      </div>
    </div>
  );
}
