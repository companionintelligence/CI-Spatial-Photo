import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ControlsPanel from './ControlsPanel';

describe('ControlsPanel', () => {
  const mockOnPredict = jest.fn();
  const mockOnRender = jest.fn();

  const defaultProps = {
    isDarkMode: true,
    onPredict: mockOnPredict,
    onRender: mockOnRender,
    loading: false,
    error: null,
    output: null,
  };

  it('renders predict tab by default', () => {
    render(<ControlsPanel {...defaultProps} />);
    expect(screen.getByText('Predict')).toHaveClass('text-blue-500');
    expect(screen.getByText('Render')).toHaveClass('text-gray-500');
  });

  it('switches tabs', () => {
    render(<ControlsPanel {...defaultProps} />);
    const renderTab = screen.getByText('Render');
    fireEvent.click(renderTab);
    expect(renderTab).toHaveClass('text-blue-500');
    expect(screen.getByText('Predict')).toHaveClass('text-gray-500');
  });

  it('displays error message', () => {
    render(<ControlsPanel {...defaultProps} error="Something went wrong" />);
    expect(screen.getByText('Error:')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('displays output', () => {
    const output = {
      job_id: '123',
      output_files: ['test.ply'],
      stdout: 'Process complete'
    };
    render(<ControlsPanel {...defaultProps} output={output} />);
    expect(screen.getByText('Success!')).toBeInTheDocument();
    expect(screen.getByText('Job ID: 123')).toBeInTheDocument();
    expect(screen.getByText('test.ply')).toBeInTheDocument();
  });

  it('shows the app 2.0 redesign plan', () => {
    render(<ControlsPanel {...defaultProps} />);
    expect(screen.getByText('App 2.0 redesign plan')).toBeInTheDocument();
    expect(screen.getByText(/4DGS-Video-Generator/)).toBeInTheDocument();
    expect(screen.getByText(/AR magic portal viewer/)).toBeInTheDocument();
  });
});
